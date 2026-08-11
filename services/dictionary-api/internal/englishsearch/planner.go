// Package englishsearch turns an explicitly submitted English query into a
// bounded batch dictionary lookup plan. It does not perform storage or HTTP work.
package englishsearch

import (
	"context"
	"errors"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"dictionary-api/internal/searchtext"
	"dictionary-api/internal/typo"
	"golang.org/x/text/unicode/norm"
)

const (
	DefaultMaxQueryRunes       = 200
	DefaultMaxTokens           = 12
	DefaultMaxPhraseWords      = 5
	DefaultMaxPhraseProbes     = 24
	DefaultMaxCorrectionProbes = 8
	DefaultMaxGroups           = 8
)

const (
	hardMaxQueryRunes       = 200
	hardMaxTokens           = 24
	hardMaxPhraseWords      = 8
	hardMaxPhraseProbes     = 48
	hardMaxCorrectionProbes = 16
	hardMaxGroups           = 16
)

var (
	ErrEmptyQuery = errors.New("English query is empty")
	ErrQueryLong  = errors.New("English query exceeds the allowed length")
)

// Options limits all work emitted by the planner. Zero values use the defaults;
// caller supplied values cannot exceed the package's hard upper bounds.
type Options struct {
	MaxQueryRunes       int
	MaxTokens           int
	MaxPhraseWords      int
	MaxPhraseProbes     int
	MaxCorrectionProbes int
	MaxGroups           int
}

// MatchKind identifies why a resolver considers a term valid.
type MatchKind string

const (
	MatchHeadword   MatchKind = "headword"
	MatchVariant    MatchKind = "variant"
	MatchPhrase     MatchKind = "phrase"
	MatchPattern    MatchKind = "pattern"
	MatchEtymology  MatchKind = "etymology"
	MatchInflection MatchKind = "inflection"
)

// Match is resolver-owned dictionary evidence. Relation is descriptive metadata
// such as the canonical lemma for an inflected form; an empty relation denotes
// a direct independent entry when the kind permits one.
type Match struct {
	EntryID  string
	Headword string
	Display  string
	Kind     MatchKind
	Relation string
	Location Location
	Evidence *Evidence
}

// Evidence is the contextual dictionary content behind a phrase match.
type Evidence struct {
	Scope          string
	CandidateText  string
	DefinitionText string
	ChineseText    string
	SemanticRole   string
	Location       Location
}

// Location identifies the dictionary node that produced an English match. It
// deliberately mirrors only transport-neutral navigation data.
type Location struct {
	Section string
	Part    string
	OwnerID string
	Path    []string
}

// GroupKind distinguishes the primary exact query from matched phrases and
// secondary submitted sentence terms.
type GroupKind string

const (
	GroupExact  GroupKind = "exact"
	GroupPhrase GroupKind = "phrase"
	GroupToken  GroupKind = "token"
)

// Group is a search unit in presentation priority order.
type Group struct {
	Text    string
	Kind    GroupKind
	Matches []Match
}

// PhraseProbe holds a normalized sequence of informative tokens. Stop words are
// omitted so a phrase such as "put through" remains discoverable in a sentence.
// TokenIndexes allow the planner to remove phrase-covered secondary terms after
// a resolver identifies which stored phrases actually exist.
type PhraseProbe struct {
	Text         string
	SurfaceText  string
	TokenIndexes []int
}

// TokenProbe is a possible secondary lookup, present only on explicit submit.
type TokenProbe struct {
	Text       string
	TokenIndex int
}

// Request is a single bounded batch request. A resolver should answer all of
// its fields in one storage round trip instead of issuing one query per token.
type Request struct {
	Exact            string
	PhraseProbes     []PhraseProbe
	TokenProbes      []TokenProbe
	CorrectionProbes []string
	Truncated        bool
}

// Results are keyed by the normalized terms from Request. Missing map keys mean
// no dictionary evidence. A resolver may return more than one Match per term.
type Results struct {
	Exact       []Match
	Phrases     map[string][]Match
	Tokens      map[string][]Match
	Corrections map[string][]Match
}

// Resolver is the only integration boundary required by the planner.
type Resolver interface {
	ResolveEnglishSearch(context.Context, Request) (Results, error)
}

// SpellingSuggestion is advisory data. Plan.Query always remains the submitted
// query; callers must require an explicit user choice before searching Suggestion.
type SpellingSuggestion struct {
	Input      string
	Suggestion string
	Matches    []Match
}

// Plan retains the exact query first, then selected longest stored phrases, and
// finally uncovered informative terms when the caller marked the query submitted.
type Plan struct {
	Query      string
	Exact      Group
	Phrases    []Group
	Tokens     []Group
	Correction *SpellingSuggestion
}

// Planner is immutable after construction and safe for concurrent use.
type Planner struct{ options Options }

func New(options Options) Planner { return Planner{options: normalizeOptions(options)} }

// BuildRequest tokenizes and bounds a query without performing any lookup.
func (p Planner) BuildRequest(raw string, submitted bool) (Request, error) {
	options := p.resolvedOptions()
	if utf8.RuneCountInString(raw) > options.MaxQueryRunes {
		return Request{}, ErrQueryLong
	}

	tokens := lexicalTokens(raw)
	if len(tokens) == 0 {
		return Request{}, ErrEmptyQuery
	}
	exact := joinTokens(tokens)
	analysisTokens := tokens
	truncated := len(analysisTokens) > options.MaxTokens
	if truncated {
		analysisTokens = analysisTokens[:options.MaxTokens]
	}
	significant := informativeUnique(analysisTokens)
	request := Request{Exact: exact, Truncated: truncated}
	if submitted {
		request.PhraseProbes = phraseProbes(analysisTokens, options)
		// A single submitted word is already represented by the exact group.
		// Secondary token groups are useful only when interpreting a sentence.
		if len(analysisTokens) > 1 {
			request.TokenProbes = tokenProbes(significant)
		}
	}
	if len(tokens) == 1 && tokens[0].Text == exact {
		for _, candidate := range typo.DirectCandidates(exact) {
			if len(request.CorrectionProbes) == options.MaxCorrectionProbes {
				break
			}
			request.CorrectionProbes = append(request.CorrectionProbes, candidate)
		}
	}
	return request, nil
}

// Plan resolves one batch request and turns the evidence into ordered groups.
func (p Planner) Plan(ctx context.Context, raw string, submitted bool, resolver Resolver) (Plan, error) {
	if resolver == nil {
		return Plan{}, errors.New("English search resolver is nil")
	}
	request, err := p.BuildRequest(raw, submitted)
	if err != nil {
		return Plan{}, err
	}
	results, err := resolver.ResolveEnglishSearch(ctx, request)
	if err != nil {
		return Plan{}, err
	}
	options := p.resolvedOptions()
	plan := Plan{
		Query: request.Exact,
		Exact: Group{Text: request.Exact, Kind: GroupExact, Matches: rankMatches(results.Exact)},
	}
	if len(plan.Exact.Matches) > 0 {
		return plan, nil
	}

	phraseCapacity := options.MaxGroups - 1
	selected := selectPhrases(request.PhraseProbes, results.Phrases, phraseCapacity)
	covered := make(map[int]struct{}, len(selected)*2)
	for _, phrase := range selected {
		plan.Phrases = append(plan.Phrases, Group{Text: phrase.Text, Kind: GroupPhrase, Matches: rankPhraseMatches(results.Phrases[phrase.Text], phrase.SurfaceText)})
		for _, index := range phrase.TokenIndexes {
			covered[index] = struct{}{}
		}
	}

	if submitted {
		remainingGroups := options.MaxGroups - 1 - len(plan.Phrases)
		for _, probe := range request.TokenProbes {
			if remainingGroups == 0 {
				break
			}
			if _, exists := covered[probe.TokenIndex]; exists {
				continue
			}
			plan.Tokens = append(plan.Tokens, Group{Text: probe.Text, Kind: GroupToken, Matches: rankMatches(results.Tokens[probe.Text])})
			remainingGroups--
		}
	}

	if len(plan.Exact.Matches) == 0 {
		plan.Correction = firstCorrection(request.Exact, request.CorrectionProbes, results.Corrections)
	}
	return plan, nil
}

func normalizeOptions(options Options) Options {
	options.MaxQueryRunes = bounded(options.MaxQueryRunes, DefaultMaxQueryRunes, hardMaxQueryRunes)
	options.MaxTokens = bounded(options.MaxTokens, DefaultMaxTokens, hardMaxTokens)
	options.MaxPhraseWords = bounded(options.MaxPhraseWords, DefaultMaxPhraseWords, hardMaxPhraseWords)
	options.MaxPhraseProbes = bounded(options.MaxPhraseProbes, DefaultMaxPhraseProbes, hardMaxPhraseProbes)
	options.MaxCorrectionProbes = bounded(options.MaxCorrectionProbes, DefaultMaxCorrectionProbes, hardMaxCorrectionProbes)
	options.MaxGroups = bounded(options.MaxGroups, DefaultMaxGroups, hardMaxGroups)
	return options
}

func (p Planner) resolvedOptions() Options { return normalizeOptions(p.options) }

func bounded(value, defaultValue, maximum int) int {
	if value <= 0 {
		return defaultValue
	}
	if value > maximum {
		return maximum
	}
	return value
}

type token struct {
	Text  string
	Index int
}

func lexicalTokens(raw string) []token {
	runes := []rune(strings.ToLower(strings.TrimSpace(norm.NFKC.String(raw))))
	tokens := make([]token, 0, 8)
	word := make([]rune, 0, 16)
	flush := func() {
		if len(word) == 0 {
			return
		}
		tokens = append(tokens, token{Text: string(word), Index: len(tokens)})
		word = word[:0]
	}
	for index, value := range runes {
		if wordRune(value) {
			word = append(word, value)
			continue
		}
		if (value == '\'' || value == '’' || value == '-') && len(word) > 0 && index+1 < len(runes) && wordRune(runes[index+1]) {
			if value == '’' {
				value = '\''
			}
			word = append(word, value)
			continue
		}
		flush()
	}
	flush()
	return tokens
}

func wordRune(value rune) bool { return unicode.IsLetter(value) || unicode.IsDigit(value) }

func joinTokens(tokens []token) string {
	terms := make([]string, len(tokens))
	for index, token := range tokens {
		terms[index] = token.Text
	}
	return strings.Join(terms, " ")
}

func informativeUnique(tokens []token) []token {
	terms := make([]token, 0, len(tokens))
	seen := make(map[string]struct{}, len(tokens))
	for _, token := range tokens {
		if searchtext.IsLightEnglishTerm(token.Text) {
			continue
		}
		if _, exists := seen[token.Text]; exists {
			continue
		}
		seen[token.Text] = struct{}{}
		terms = append(terms, token)
	}
	return terms
}

func phraseProbes(tokens []token, options Options) []PhraseProbe {
	probes := make([]PhraseProbe, 0, options.MaxPhraseProbes)
	seen := make(map[string]struct{}, options.MaxPhraseProbes)
	add := func(words []string, indexes []int, surfaceWords []string) {
		if len(words) < 2 || len(probes) == options.MaxPhraseProbes {
			return
		}
		informative := false
		for _, word := range words {
			if !searchtext.IsLightEnglishTerm(word) {
				informative = true
				break
			}
		}
		if !informative {
			return
		}
		text := strings.Join(words, " ")
		if _, exists := seen[text]; exists {
			return
		}
		seen[text] = struct{}{}
		probes = append(probes, PhraseProbe{
			Text: text, SurfaceText: strings.Join(surfaceWords, " "), TokenIndexes: indexes,
		})
	}
	maxWords := min(options.MaxPhraseWords, len(tokens))
	for length := maxWords; length >= 2 && len(probes) < options.MaxPhraseProbes; length-- {
		for start := 0; start+length <= len(tokens) && len(probes) < options.MaxPhraseProbes; start++ {
			span := tokens[start : start+length]
			words := make([]string, 0, len(span))
			indexes := make([]int, 0, len(span))
			for _, token := range span {
				words = append(words, token.Text)
				indexes = append(indexes, token.Index)
			}
			add(words, indexes, words)

			// Separable phrasal verbs commonly contain a pronoun or another light
			// token between their stored parts ("put me through"). Keep the
			// contiguous probe above, then add one bounded compressed alternative.
			compressedWords := make([]string, 0, len(span))
			compressedIndexes := make([]int, 0, len(span))
			for _, token := range span {
				if searchtext.IsLightEnglishTerm(token.Text) {
					continue
				}
				compressedWords = append(compressedWords, token.Text)
				compressedIndexes = append(compressedIndexes, token.Index)
			}
			add(compressedWords, compressedIndexes, words)
		}
	}
	return probes
}

func tokenProbes(tokens []token) []TokenProbe {
	probes := make([]TokenProbe, 0, len(tokens))
	for _, token := range tokens {
		probes = append(probes, TokenProbe{Text: token.Text, TokenIndex: token.Index})
	}
	return probes
}

func selectPhrases(probes []PhraseProbe, matches map[string][]Match, capacity int) []PhraseProbe {
	if capacity <= 0 {
		return nil
	}
	selected := make([]PhraseProbe, 0, capacity)
	covered := make(map[int]struct{})
	for _, probe := range probes { // probes are longest-first, then left-to-right.
		if len(matches[probe.Text]) == 0 || len(selected) == capacity {
			continue
		}
		overlaps := false
		for _, index := range probe.TokenIndexes {
			if _, exists := covered[index]; exists {
				overlaps = true
				break
			}
		}
		if overlaps {
			continue
		}
		selected = append(selected, probe)
		for _, index := range probe.TokenIndexes {
			covered[index] = struct{}{}
		}
	}
	sort.SliceStable(selected, func(left, right int) bool {
		return selected[left].TokenIndexes[0] < selected[right].TokenIndexes[0]
	})
	return selected
}

func firstCorrection(input string, candidates []string, corrections map[string][]Match) *SpellingSuggestion {
	for _, candidate := range candidates {
		matches := rankMatches(corrections[candidate])
		if len(matches) != 0 {
			return &SpellingSuggestion{Input: input, Suggestion: candidate, Matches: matches}
		}
	}
	return nil
}

func rankMatches(matches []Match) []Match {
	if len(matches) == 0 {
		return nil
	}
	ranked := append([]Match(nil), matches...)
	sort.SliceStable(ranked, func(left, right int) bool {
		return matchRank(ranked[left]) < matchRank(ranked[right])
	})
	unique := ranked[:0]
	seen := make(map[string]struct{}, len(ranked))
	for _, match := range ranked {
		key := strings.Join([]string{
			match.EntryID, match.Headword, string(match.Kind), match.Relation,
			match.Location.Section, match.Location.Part, match.Location.OwnerID,
			strings.Join(match.Location.Path, "\x00"),
		}, "\x01")
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		unique = append(unique, match)
	}
	return unique
}

func rankPhraseMatches(matches []Match, surface string) []Match {
	ranked := rankMatches(matches)
	sort.SliceStable(ranked, func(left, right int) bool {
		return searchtext.PhraseMatchDistance(surface, phraseMatchText(ranked[left])) <
			searchtext.PhraseMatchDistance(surface, phraseMatchText(ranked[right]))
	})
	return ranked
}

func phraseMatchText(match Match) string {
	if match.Evidence != nil && match.Evidence.CandidateText != "" {
		return match.Evidence.CandidateText
	}
	if match.Display != "" {
		return match.Display
	}
	return match.Headword
}

func matchRank(match Match) int {
	switch match.Kind {
	case MatchHeadword:
		return 0
	case MatchVariant:
		return 1
	case MatchPhrase:
		return 2
	case MatchPattern:
		return 3
	case MatchEtymology:
		return 4
	case MatchInflection:
		return 5
	default:
		return 6
	}
}
