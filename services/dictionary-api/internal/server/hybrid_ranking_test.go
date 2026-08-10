package server

import (
	"reflect"
	"testing"

	"dictionary-api/internal/reversesearch"
)

func TestHybridRankingPreservesLexicalOrderForCompleteChineseMatches(t *testing.T) {
	lexical := []suggestion{
		searchSuggestion("abandon", lexicalMatch("放弃", 4, 0)),
		searchSuggestion("bag", lexicalMatch("放弃", 4, 0)),
	}
	semantic := []suggestion{
		searchSuggestion("bag", semanticMatch("放弃", .99, 0)),
		searchSuggestion("abandon", semanticMatch("放弃", .80, 0)),
	}

	if got := suggestionIDs(mergeHybridSuggestions(lexical, semantic)); !reflect.DeepEqual(got, []string{"abandon", "bag"}) {
		t.Fatalf("complete lexical order changed: %v", got)
	}
}

func TestHybridRankingProtectsFullBoundaryLexicalMatches(t *testing.T) {
	lexical := []suggestion{
		searchSuggestion("literal-first", lexicalMatch("literal-first", protectedLexicalTier, 0)),
		searchSuggestion("literal-second", lexicalMatch("literal-second", protectedLexicalTier, 1)),
	}
	semantic := []suggestion{
		searchSuggestion("literal-second", semanticMatch("literal-second", .99, 0)),
		searchSuggestion("literal-first", semanticMatch("literal-first", .70, 0)),
	}

	if got := suggestionIDs(mergeHybridSuggestions(lexical, semantic)); !reflect.DeepEqual(got, []string{"literal-first", "literal-second"}) {
		t.Fatalf("full-boundary lexical order changed: %v", got)
	}
}

func TestHybridRankingUsesTheStrongestEvidenceBeforeCorroboration(t *testing.T) {
	semantic := []suggestion{
		searchSuggestion("b", semanticMatch("b-99", .99, 0)),
		searchSuggestion("c", semanticMatch("c-90-1", .90, 0), semanticMatch("c-90-2", .90, 1), semanticMatch("c-90-3", .90, 2)),
		searchSuggestion("a", semanticMatch("a-90", .90, 0), semanticMatch("a-70", .70, 1)),
	}

	if got := suggestionIDs(mergeHybridSuggestions(nil, semantic)); !reflect.DeepEqual(got, []string{"b", "c", "a"}) {
		t.Fatalf("evidence profile order = %v", got)
	}
}

func TestHybridRankingUsesCorroborationOnlyInsideTheEvidenceBand(t *testing.T) {
	semantic := []suggestion{
		searchSuggestion("single", semanticMatch("single", .901, 0)),
		searchSuggestion("corroborated", semanticMatch("corroborated-1", .899, 0), semanticMatch("corroborated-2", .899, 1)),
	}

	if got := suggestionIDs(mergeHybridSuggestions(nil, semantic)); !reflect.DeepEqual(got, []string{"corroborated", "single"}) {
		t.Fatalf("same-band corroboration order = %v", got)
	}
}

func TestHybridRankingLetsPartialLexicalEvidenceSupportButNotOverrideSemanticEvidence(t *testing.T) {
	lexical := []suggestion{
		searchSuggestion("literal-fragment", lexicalMatch("银行", 1, 0)),
		searchSuggestion("river-bank", lexicalMatch("河岸", 1, 0)),
	}
	semantic := []suggestion{
		searchSuggestion("river-bank", semanticMatch("河岸", .91, 0)),
		searchSuggestion("literal-fragment", semanticMatch("银行", .72, 0)),
	}

	if got := suggestionIDs(mergeHybridSuggestions(lexical, semantic)); !reflect.DeepEqual(got, []string{"river-bank", "literal-fragment"}) {
		t.Fatalf("partial lexical evidence overrode semantic intent: %v", got)
	}
}

func TestHybridEvidenceMergesSignalsAndRetainsAReadableBound(t *testing.T) {
	lexical := make([]searchMatch, 0, maxSearchMatches)
	semantic := make([]searchMatch, 0, maxSearchMatches)
	for index := 0; index < maxSearchMatches; index++ {
		lexical = append(lexical, lexicalMatch(string(rune('a'+index)), 1, index))
		semantic = append(semantic, semanticMatch(string(rune('a'+index)), .90-float32(index)/100, index))
	}
	merged := mergeSearchMatches(lexical, semantic)
	if len(merged) != maxSearchMatches {
		t.Fatalf("merged evidence length = %d", len(merged))
	}
	for _, match := range merged {
		if !match.hasLexical || !match.hasSemantic {
			t.Fatalf("duplicate evidence did not combine retrieval signals: %#v", match)
		}
	}
}

func TestHybridEvidenceKeepsTheStrongestDuplicateSignalRegardlessOfArrivalOrder(t *testing.T) {
	weak := semanticMatch("same", .72, 4)
	strong := semanticMatch("same", .91, 2)
	forward := mergeSearchMatches([]searchMatch{weak}, []searchMatch{strong})
	reverse := mergeSearchMatches([]searchMatch{strong}, []searchMatch{weak})
	for _, merged := range [][]searchMatch{forward, reverse} {
		if len(merged) != 1 || merged[0].semanticScore != .91 || merged[0].semanticPosition != 2 {
			t.Fatalf("duplicate semantic signal was order-dependent: %#v", merged)
		}
	}
}

func searchSuggestion(id string, matches ...searchMatch) suggestion {
	return suggestion{ID: id, Headword: id, Matches: matches}
}

func lexicalMatch(chinese string, tier, position int) searchMatch {
	return searchMatch{
		Scope: reversesearch.ScopeSense, EnglishText: chinese, ChineseText: chinese,
		Location:   reversesearch.Location{Section: reversesearch.SectionDefinitions, OwnerID: chinese, Path: []string{chinese}},
		hasLexical: true, lexicalPosition: position,
		lexicalRelevance: reversesearch.Relevance{Tier: tier},
	}
}

func semanticMatch(chinese string, score float32, position int) searchMatch {
	return searchMatch{
		Scope: reversesearch.ScopeSense, EnglishText: chinese, ChineseText: chinese,
		Location:    reversesearch.Location{Section: reversesearch.SectionDefinitions, OwnerID: chinese, Path: []string{chinese}},
		hasSemantic: true, semanticPosition: position, semanticScore: score,
	}
}

func suggestionIDs(items []suggestion) []string {
	ids := make([]string, len(items))
	for index, item := range items {
		ids[index] = item.ID
	}
	return ids
}
