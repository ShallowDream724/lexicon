// Package searchtext provides the shared ASCII query interpretation used by search stores.
package searchtext

import (
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

var stopWords = map[string]struct{}{
	"a": {}, "an": {}, "the": {}, "to": {}, "of": {}, "on": {}, "no": {}, "i": {}, "and": {}, "or": {},
}

const maxPhraseIndexTerms = 24
const maxPhraseMatchWords = 32

var (
	phraseLightWords = map[string]struct{}{
		"a": {}, "am": {}, "an": {}, "and": {}, "are": {}, "as": {}, "at": {}, "be": {}, "been": {}, "being": {},
		"but": {}, "by": {}, "could": {}, "do": {}, "for": {}, "from": {}, "has": {}, "have": {}, "he": {}, "her": {},
		"him": {}, "i": {}, "in": {}, "is": {}, "it": {}, "its": {}, "me": {}, "my": {}, "of": {}, "on": {}, "or": {},
		"our": {}, "she": {}, "that": {}, "the": {}, "their": {}, "them": {}, "this": {}, "to": {}, "us": {}, "was": {},
		"we": {}, "were": {}, "will": {}, "with": {}, "would": {}, "you": {}, "your": {},
	}
	phrasePlaceholders = map[string]struct{}{
		"one": {}, "oneself": {}, "sb": {}, "sb's": {}, "somebody": {}, "someone": {}, "something": {}, "sth": {}, "sth's": {},
		"herself": {}, "himself": {}, "itself": {}, "myself": {}, "ourselves": {}, "themselves": {}, "yourself": {}, "yourselves": {},
	}
	personPhraseTerms = map[string]struct{}{
		"her": {}, "him": {}, "me": {}, "one": {}, "sb": {}, "somebody": {}, "someone": {}, "them": {}, "us": {}, "you": {},
	}
	thingPhraseTerms = map[string]struct{}{
		"it": {}, "something": {}, "sth": {}, "that": {}, "this": {},
	}
	slashAlternatives = regexp.MustCompile(`(?i)\b[a-z]+(?:/[a-z]+)+\b`)
	phraseClauses     = regexp.MustCompile(`(?:[|,;]+|\.{3,}|…+)`)
)

// AnchorTerm is an exact normalized headword candidate. Ordinal preserves query order.
type AnchorTerm struct {
	Term    string
	Ordinal int
}

// QueryProfile holds the ASCII interpretation of one user query.
type QueryProfile struct {
	allTerms    []string
	anchorTerms []AnchorTerm
	significant map[string]struct{}
}

// NewQueryProfile normalizes query text once and derives filtering, anchoring, and evidence terms.
func NewQueryProfile(query string) QueryProfile {
	normalized := normalizeASCII(query)
	tokens := asciiTokens(normalized)
	allTerms := uniqueTerms(asciiFilterTokens(normalized))
	significant := make(map[string]struct{}, len(allTerms))
	for _, term := range allTerms {
		if _, stop := stopWords[term.value]; !stop {
			significant[term.value] = struct{}{}
		}
	}

	anchors := make([]AnchorTerm, 0, len(allTerms))
	seen := make(map[string]struct{}, len(allTerms))
	add := func(term string) {
		if term == "" {
			return
		}
		if _, exists := seen[term]; exists {
			return
		}
		seen[term] = struct{}{}
		anchors = append(anchors, AnchorTerm{Term: term, Ordinal: len(anchors)})
	}
	for _, phrase := range asciiPhrases(normalized, tokens) {
		hasSignificant := false
		for _, token := range phrase {
			if tokenIsSignificant(token, significant) {
				hasSignificant = true
				break
			}
		}
		if len(significant) > 0 && !hasSignificant {
			continue
		}
		add(strings.Join(tokenValues(phrase), " "))
		for _, token := range phrase {
			if len(significant) == 0 {
				add(token.value)
				continue
			}
			if tokenIsSignificant(token, significant) {
				add(token.value)
			}
		}
	}

	return QueryProfile{allTerms: tokenValues(allTerms), anchorTerms: anchors, significant: significant}
}

// NewProfile is a concise alias for NewQueryProfile.
func NewProfile(query string) QueryProfile { return NewQueryProfile(query) }

// AllTerms returns unique ASCII tokens for the existing mixed-query filtering path.
func (profile QueryProfile) AllTerms() []string { return append([]string(nil), profile.allTerms...) }

// AnchorTerms returns ordered exact headword candidates. Function words remain only when needed.
func (profile QueryProfile) AnchorTerms() []AnchorTerm {
	return append([]AnchorTerm(nil), profile.anchorTerms...)
}

// EvidenceHits reports unique matching significant terms, followed by all matching ASCII terms.
func (profile QueryProfile) EvidenceHits(values ...string) (significantHits, allHits int) {
	if len(profile.allTerms) == 0 {
		return 0, 0
	}
	matched := make(map[string]struct{}, len(profile.allTerms))
	for _, value := range values {
		for _, token := range asciiFilterTokens(normalizeASCII(value)) {
			matched[token.value] = struct{}{}
		}
	}
	for _, term := range profile.allTerms {
		if _, exists := matched[term]; !exists {
			continue
		}
		allHits++
		if len(profile.significant) == 0 {
			significantHits++
			continue
		}
		if _, exists := profile.significant[term]; exists {
			significantHits++
		}
	}
	return significantHits, allHits
}

// NormalizeHeadwordTerm produces the canonical exact-key representation for a headword or form.
func NormalizeHeadwordTerm(value string) string {
	value = strings.NewReplacer("ˈ", "", "ˌ", "").Replace(value)
	return strings.Join(tokenValues(asciiTokens(normalizeASCII(value))), " ")
}

// IsLightEnglishTerm identifies function words and pronouns that may sit between
// the meaningful parts of a stored dictionary phrase.
func IsLightEnglishTerm(value string) bool {
	_, exists := phraseLightWords[NormalizeHeadwordTerm(value)]
	return exists
}

// PhraseIndexTerms derives a bounded set of exact lookup keys from dictionary
// notation. It keeps the original phrase while adding source-neutral forms for
// optional groups, slash alternatives, and grammatical placeholders such as sb/sth.
func PhraseIndexTerms(value string) []string {
	terms := make([]string, 0, 8)
	seen := make(map[string]struct{}, 8)
	add := func(candidate string, derived bool) {
		term := NormalizeHeadwordTerm(candidate)
		if term == "" || len(term) > 1024 || derived && len(strings.Fields(term)) < 2 {
			return
		}
		if _, exists := seen[term]; exists || len(terms) == maxPhraseIndexTerms {
			return
		}
		seen[term] = struct{}{}
		terms = append(terms, term)
	}
	add(value, false)

	for _, source := range phraseSources(value) {
		for _, expanded := range expandSlashAlternatives(source, maxPhraseIndexTerms-len(terms)) {
			add(expanded, true)
			normalized := NormalizeHeadwordTerm(expanded)
			words := strings.Fields(normalized)
			structural := filterPhraseWords(words, false)
			add(strings.Join(structural, " "), true)
			add(strings.Join(filterPhraseWords(words, true), " "), true)
		}
	}
	return terms
}

// PhraseMatchDistance compares a natural query fragment with dictionary phrase
// notation. A lower value is a closer structural match; optional groups and
// slash alternatives are evaluated without changing the stored display text.
func PhraseMatchDistance(query, candidate string) int {
	queryWords := strings.Fields(NormalizeHeadwordTerm(query))
	if len(queryWords) == 0 {
		return maxPhraseMatchWords * 2
	}
	if len(queryWords) > maxPhraseMatchWords {
		queryWords = queryWords[:maxPhraseMatchWords]
	}
	best := maxPhraseMatchWords * 2
	for _, source := range phraseSources(candidate) {
		for _, expanded := range expandSlashAlternatives(source, maxPhraseIndexTerms) {
			candidateWords := strings.Fields(NormalizeHeadwordTerm(expanded))
			if len(candidateWords) > maxPhraseMatchWords {
				candidateWords = candidateWords[:maxPhraseMatchWords]
			}
			if distance := phraseEditDistance(queryWords, candidateWords); distance < best {
				best = distance
			}
		}
	}
	return best
}

func phraseSources(value string) []string {
	sources := []string{value, stripOptionalGroups(value)}
	for _, source := range append([]string(nil), sources...) {
		sources = append(sources, phraseClauses.Split(source, -1)...)
	}
	return sources
}

func phraseEditDistance(query, candidate []string) int {
	previous := make([]int, len(candidate)+1)
	current := make([]int, len(candidate)+1)
	for index := range previous {
		previous[index] = index
	}
	for queryIndex, queryWord := range query {
		current[0] = queryIndex + 1
		for candidateIndex, candidateWord := range candidate {
			current[candidateIndex+1] = min(
				previous[candidateIndex+1]+1,
				current[candidateIndex]+1,
				previous[candidateIndex]+phraseSubstitutionCost(queryWord, candidateWord),
			)
		}
		previous, current = current, previous
	}
	return previous[len(candidate)]
}

func phraseSubstitutionCost(query, candidate string) int {
	if query == candidate {
		return 0
	}
	if candidate == "sb" {
		if _, matches := personPhraseTerms[query]; matches {
			return 0
		}
		return 1
	}
	if candidate == "sth" {
		if _, matches := thingPhraseTerms[query]; matches {
			return 0
		}
		return 1
	}
	if _, placeholder := phrasePlaceholders[candidate]; placeholder {
		return 1
	}
	return 2
}

func filterPhraseWords(words []string, compact bool) []string {
	filtered := make([]string, 0, len(words))
	for _, word := range words {
		if _, placeholder := phrasePlaceholders[word]; placeholder {
			continue
		}
		if compact {
			if _, light := phraseLightWords[word]; light {
				continue
			}
		}
		filtered = append(filtered, word)
	}
	return filtered
}

func stripOptionalGroups(value string) string {
	var result strings.Builder
	depth := 0
	for _, character := range value {
		switch character {
		case '(':
			depth++
		case ')':
			if depth > 0 {
				depth--
			}
		default:
			if depth == 0 {
				result.WriteRune(character)
			}
		}
	}
	return result.String()
}

func expandSlashAlternatives(value string, limit int) []string {
	if limit <= 0 {
		return nil
	}
	values := []string{value}
	for index := 0; index < len(values) && len(values) < limit; index++ {
		location := slashAlternatives.FindStringIndex(values[index])
		if location == nil {
			continue
		}
		current := values[index]
		values[index] = ""
		for _, alternative := range strings.Split(current[location[0]:location[1]], "/") {
			if len(values) == limit {
				break
			}
			values = append(values, current[:location[0]]+alternative+current[location[1]:])
		}
	}
	result := values[:0]
	for _, candidate := range values {
		if candidate != "" {
			result = append(result, candidate)
		}
	}
	return result
}

type asciiToken struct {
	value      string
	start, end int
}

func normalizeASCII(value string) string {
	value = norm.NFKC.String(value)
	value = strings.Map(func(r rune) rune {
		switch r {
		case '\u2010', '\u2011', '\u2012', '\u2013', '\u2014', '\u2212':
			return '-'
		default:
			return unicode.ToLower(r)
		}
	}, value)
	return value
}

func asciiTokens(value string) []asciiToken {
	tokens := make([]asciiToken, 0, 2)
	for index := 0; index < len(value); {
		if !asciiAlphaNumeric(value[index]) {
			index++
			continue
		}
		start := index
		index++
		for index < len(value) {
			if asciiAlphaNumeric(value[index]) {
				index++
				continue
			}
			if (value[index] == '-' || value[index] == '\'') && index+1 < len(value) && asciiAlphaNumeric(value[index+1]) {
				index += 2
				continue
			}
			break
		}
		if hasExactASCIIBoundaries(value, start, index) {
			tokens = append(tokens, asciiToken{value: value[start:index], start: start, end: index})
		}
	}
	return tokens
}

func asciiFilterTokens(value string) []asciiToken {
	tokens := make([]asciiToken, 0, 2)
	for index := 0; index < len(value); {
		if !asciiAlphaNumeric(value[index]) {
			index++
			continue
		}
		start := index
		for index < len(value) && asciiAlphaNumeric(value[index]) {
			index++
		}
		if hasExactASCIIBoundaries(value, start, index) {
			tokens = append(tokens, asciiToken{value: value[start:index], start: start, end: index})
		}
	}
	return tokens
}

func asciiAlphaNumeric(value byte) bool {
	return value >= 'a' && value <= 'z' || value >= '0' && value <= '9'
}

func hasExactASCIIBoundaries(value string, start, end int) bool {
	return !adjacentNonASCIIWord(value, start, false) && !adjacentNonASCIIWord(value, end, true)
}

func adjacentNonASCIIWord(value string, boundary int, forward bool) bool {
	read := func() (rune, bool) {
		if forward {
			if boundary >= len(value) {
				return 0, false
			}
			r, size := utf8.DecodeRuneInString(value[boundary:])
			boundary += size
			return r, true
		}
		if boundary <= 0 {
			return 0, false
		}
		r, size := utf8.DecodeLastRuneInString(value[:boundary])
		boundary -= size
		return r, true
	}

	r, ok := read()
	for ok && (r == '-' || r == '\'') {
		r, ok = read()
	}
	if !ok || r <= unicode.MaxASCII || unicode.Is(unicode.Han, r) {
		return false
	}
	return unicode.IsLetter(r) || unicode.IsNumber(r)
}

func uniqueTerms(tokens []asciiToken) []asciiToken {
	unique := make([]asciiToken, 0, len(tokens))
	seen := make(map[string]struct{}, len(tokens))
	for _, token := range tokens {
		if _, exists := seen[token.value]; exists {
			continue
		}
		seen[token.value] = struct{}{}
		unique = append(unique, token)
	}
	return unique
}

func asciiPhrases(value string, tokens []asciiToken) [][]asciiToken {
	phrases := make([][]asciiToken, 0, len(tokens))
	for start := 0; start < len(tokens); {
		end := start + 1
		for end < len(tokens) && strings.TrimSpace(value[tokens[end-1].end:tokens[end].start]) == "" {
			end++
		}
		phrases = append(phrases, tokens[start:end])
		start = end
	}
	return phrases
}

func tokenIsSignificant(token asciiToken, significant map[string]struct{}) bool {
	for _, part := range asciiFilterTokens(token.value) {
		if _, exists := significant[part.value]; exists {
			return true
		}
	}
	return false
}

func tokenValues(tokens []asciiToken) []string {
	values := make([]string, len(tokens))
	for index, token := range tokens {
		values[index] = token.value
	}
	return values
}
