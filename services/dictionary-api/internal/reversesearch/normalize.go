package reversesearch

import (
	"fmt"
	"strings"
	"sync"
	"unicode"

	"dictionary-api/internal/searchtext"
	"github.com/longbridgeapp/opencc"
	"golang.org/x/text/unicode/norm"
)

var loadTraditionalConverter = sync.OnceValues(func() (*opencc.OpenCC, error) {
	return opencc.New("t2s")
})

func normalizeChinese(value string) string {
	value = norm.NFKC.String(value)
	converter, err := loadTraditionalConverter()
	if err != nil {
		panic(fmt.Sprintf("initialize traditional Chinese normalizer: %v", err))
	}
	value, err = converter.Convert(value)
	if err != nil {
		panic(fmt.Sprintf("normalize traditional Chinese: %v", err))
	}
	return normalizeChineseSpacing(value)
}

func normalizeChineseWithoutTraditionalConversion(value string) string {
	return normalizeChineseSpacing(norm.NFKC.String(value))
}

func normalizeChineseSpacing(value string) string {
	var out strings.Builder
	out.Grow(len(value))
	space := true
	for _, r := range value {
		if r == '矽' {
			r = '硅'
		}
		if unicode.IsSpace(r) || isPunctuation(r) {
			if !space {
				out.WriteByte(' ')
				space = true
			}
			continue
		}
		out.WriteRune(r)
		space = false
	}
	return strings.TrimSpace(out.String())
}

func isPunctuation(r rune) bool {
	return unicode.IsPunct(r) || unicode.IsSymbol(r)
}

func isCJK(r rune) bool {
	return (r >= 0x3400 && r <= 0x4DBF) || (r >= 0x4E00 && r <= 0x9FFF) ||
		(r >= 0xF900 && r <= 0xFAFF) || (r >= 0x20000 && r <= 0x2EBEF)
}

func ContainsCJK(value string) bool {
	for _, r := range value {
		if isCJK(r) {
			return true
		}
	}
	return false
}

// ContainsExactChineseSegment reports whether query matches one complete normalized
// Chinese segment in value. It shares the importer's punctuation and traditional-
// Chinese normalization, so hybrid ranking protects the same exact evidence as the
// reverse-search index.
func ContainsExactChineseSegment(value, query string) bool {
	querySequences := cjkSequences(query)
	if len(querySequences) != 1 {
		return false
	}
	wanted := string(querySequences[0])
	for _, sequence := range cjkSequences(value) {
		if string(sequence) == wanted {
			return true
		}
	}
	return false
}

func cjkSequences(value string) [][]rune {
	return cjkSequencesFromNormalized(normalizeChinese(value))
}

func cjkSequencesWithoutTraditionalConversion(value string) [][]rune {
	return cjkSequencesFromNormalized(normalizeChineseWithoutTraditionalConversion(value))
}

func cjkSequencesFromNormalized(normalized string) [][]rune {
	sequences := make([][]rune, 0, 4)
	current := make([]rune, 0, len(normalized))
	flush := func() {
		if len(current) > 0 {
			sequences = append(sequences, current)
			current = nil
		}
	}
	for _, r := range normalized {
		if isCJK(r) {
			current = append(current, r)
		} else {
			flush()
		}
	}
	flush()
	return sequences
}

func cjkRunes(value string) []rune {
	return cjkRunesFromSequences(cjkSequences(value))
}

func cjkRunesFromSequences(sequences [][]rune) []rune {
	count := 0
	for _, sequence := range sequences {
		count += len(sequence)
	}
	runes := make([]rune, 0, count)
	for _, sequence := range sequences {
		runes = append(runes, sequence...)
	}
	return runes
}

func hasNegation(values []rune) bool {
	for index := 1; index < len(values); index++ {
		if values[index-1] == '难' && (values[index] == '以' || values[index] == '于') {
			return true
		}
	}
	for _, value := range values {
		switch value {
		case '不', '没', '无', '未', '非', '莫', '别', '勿':
			return true
		}
	}
	return false
}

func exactMatchOnlyInsideBrackets(value string, query []rune) bool {
	if len(query) == 0 {
		return false
	}
	values := []rune(norm.NFKC.String(value))
	depth := 0
	inside, outside := false, false
	for index, value := range values {
		if isOpeningBracket(value) {
			depth++
			continue
		}
		if isClosingBracket(value) {
			if depth > 0 {
				depth--
			}
			continue
		}
		if index+len(query) > len(values) {
			continue
		}
		matched := true
		for offset, wanted := range query {
			actual := values[index+offset]
			if actual == '矽' {
				actual = '硅'
			}
			if actual != wanted {
				matched = false
				break
			}
		}
		if !matched {
			continue
		}
		if depth > 0 {
			inside = true
		} else {
			outside = true
		}
	}
	return inside && !outside
}

func asciiQueryTerms(value string) []string {
	return searchtext.NewQueryProfile(value).AllTerms()
}

func isOpeningBracket(value rune) bool {
	switch value {
	case '(', '[', '{', '<', '【', '〔', '《', '〈', '「', '『':
		return true
	}
	return false
}

func isClosingBracket(value rune) bool {
	switch value {
	case ')', ']', '}', '>', '】', '〕', '》', '〉', '」', '』':
		return true
	}
	return false
}

// Tokens are ASCII-only, making MATCH construction independent of SQLite tokenizers.
func tokens(value string) []string {
	sequences := cjkSequences(value)
	if len(sequences) == 0 {
		return nil
	}
	result := make([]string, 0, len(value))
	seen := make(map[string]struct{}, len(value))
	add := func(token string) {
		if _, exists := seen[token]; exists {
			return
		}
		seen[token] = struct{}{}
		result = append(result, token)
	}
	for _, sequence := range sequences {
		for index, r := range sequence {
			add(encodeRune(r))
			if index > 0 {
				add(encodeBigram(sequence[index-1], r))
			}
		}
	}
	return result
}

func queryTokens(value string) []string {
	return queryTokensFromSequences(cjkSequences(value))
}

func queryTokensFromSequences(sequences [][]rune) []string {
	result := make([]string, 0, len(sequences)*2)
	seen := make(map[string]struct{}, len(sequences)*2)
	add := func(token string) {
		if _, exists := seen[token]; exists {
			return
		}
		seen[token] = struct{}{}
		result = append(result, token)
	}
	for _, sequence := range sequences {
		if len(sequence) == 1 {
			add(encodeRune(sequence[0]))
			continue
		}
		for index := 1; index < len(sequence); index++ {
			add(encodeBigram(sequence[index-1], sequence[index]))
		}
	}
	return result
}

func encodeRune(r rune) string {
	return "u" + strings.ToLower(string([]byte{hexDigit(byte(r >> 20)), hexDigit(byte(r >> 16)), hexDigit(byte(r >> 12)), hexDigit(byte(r >> 8)), hexDigit(byte(r >> 4)), hexDigit(byte(r))}))
}

func encodeBigram(left, right rune) string { return "b" + encodeRune(left)[1:] + encodeRune(right)[1:] }

func hexDigit(value byte) byte {
	value &= 0x0f
	if value < 10 {
		return '0' + value
	}
	return 'a' + value - 10
}

func matchExpression(queryTokens []string) string {
	return strings.Join(queryTokens, " OR ")
}

func conjunctiveMatchExpression(queryTokens []string) string {
	return strings.Join(queryTokens, " AND ")
}

type commonRunMatcher struct {
	states []commonRunState
}

type commonRunState struct {
	length int
	link   int
	next   map[rune]int
}

func newCommonRunMatcher(query []rune) commonRunMatcher {
	matcher := commonRunMatcher{states: []commonRunState{{link: -1, next: make(map[rune]int)}}}
	last := 0
	for _, r := range query {
		current := len(matcher.states)
		matcher.states = append(matcher.states, commonRunState{
			length: matcher.states[last].length + 1,
			link:   0,
			next:   make(map[rune]int),
		})

		state := last
		for state >= 0 {
			if _, exists := matcher.states[state].next[r]; exists {
				break
			}
			matcher.states[state].next[r] = current
			state = matcher.states[state].link
		}
		if state < 0 {
			matcher.states[current].link = 0
			last = current
			continue
		}

		candidate := matcher.states[state].next[r]
		if matcher.states[state].length+1 == matcher.states[candidate].length {
			matcher.states[current].link = candidate
			last = current
			continue
		}

		clone := len(matcher.states)
		transitions := make(map[rune]int, len(matcher.states[candidate].next))
		for key, value := range matcher.states[candidate].next {
			transitions[key] = value
		}
		matcher.states = append(matcher.states, commonRunState{
			length: matcher.states[state].length + 1,
			link:   matcher.states[candidate].link,
			next:   transitions,
		})
		for state >= 0 && matcher.states[state].next[r] == candidate {
			matcher.states[state].next[r] = clone
			state = matcher.states[state].link
		}
		matcher.states[candidate].link = clone
		matcher.states[current].link = clone
		last = current
	}
	return matcher
}

func (matcher commonRunMatcher) longest(target []rune) int {
	state, length, longest := 0, 0, 0
	for _, r := range target {
		for state != 0 {
			if _, exists := matcher.states[state].next[r]; exists {
				break
			}
			state = matcher.states[state].link
			length = matcher.states[state].length
		}
		if next, exists := matcher.states[state].next[r]; exists {
			state = next
			length++
		} else {
			state, length = 0, 0
		}
		if length > longest {
			longest = length
		}
	}
	return longest
}
