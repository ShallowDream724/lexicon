package server

import (
	"reflect"
	"testing"

	"dictionary-api/internal/reversesearch"
	"dictionary-api/internal/searchtext"
	"dictionary-api/internal/semanticsearch"
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

	if got := suggestionIDs(mergeHybridSuggestions(nil, lexical, semantic)); !reflect.DeepEqual(got, []string{"abandon", "bag"}) {
		t.Fatalf("complete lexical order changed: %v", got)
	}
}

func TestHybridRankingKeepsPureChineseOrderingWithoutASCIIEvidence(t *testing.T) {
	lexical := []suggestion{
		searchSuggestion("abandon", lexicalMatch("放弃", 4, 0)),
		searchSuggestion("bag", lexicalMatch("放弃", 4, 0)),
	}
	semantic := []suggestion{
		searchSuggestion("bag", semanticMatch("放弃", .99, 0)),
		searchSuggestion("abandon", semanticMatch("放弃", .80, 0)),
	}

	profile := searchtext.NewQueryProfile("放弃的意思")
	if got := suggestionIDs(mergeHybridSuggestions(profile, lexical, semantic)); !reflect.DeepEqual(got, []string{"abandon", "bag"}) {
		t.Fatalf("pure Chinese ordering changed: %v", got)
	}
}

func TestHybridRankingProtectsExactAndGrammaticalLexicalMatches(t *testing.T) {
	lexical := []suggestion{
		searchSuggestion("literal-first", lexicalMatch("literal-first", protectedLexicalTier, 0)),
		searchSuggestion("literal-second", lexicalMatch("literal-second", protectedLexicalTier, 1)),
	}
	semantic := []suggestion{
		searchSuggestion("literal-second", semanticMatch("literal-second", .99, 0)),
		searchSuggestion("literal-first", semanticMatch("literal-first", .70, 0)),
	}

	if got := suggestionIDs(mergeHybridSuggestions(nil, lexical, semantic)); !reflect.DeepEqual(got, []string{"literal-first", "literal-second"}) {
		t.Fatalf("full-boundary lexical order changed: %v", got)
	}
}

func TestHybridRankingLetsSemanticIntentBeatAContainedLexicalFragment(t *testing.T) {
	lexical := []suggestion{
		searchSuggestion("needle", lexicalMatch("几乎不可能找到的东西", protectedLexicalTier-1, 0)),
	}
	semantic := []suggestion{
		searchSuggestion("needle", semanticMatch("几乎不可能找到的东西", .72, 1)),
		searchSuggestion("impossible", semanticMatch("不可能的", .91, 0)),
	}

	if got := suggestionIDs(mergeHybridSuggestions(nil, lexical, semantic)); !reflect.DeepEqual(got, []string{"impossible", "needle"}) {
		t.Fatalf("contained lexical fragment overrode semantic intent: %v", got)
	}
}

func TestHybridRankingUsesTheStrongestEvidenceBeforeCorroboration(t *testing.T) {
	semantic := []suggestion{
		searchSuggestion("b", semanticMatch("b-99", .99, 0)),
		searchSuggestion("c", semanticMatch("c-90-1", .90, 0), semanticMatch("c-90-2", .90, 1), semanticMatch("c-90-3", .90, 2)),
		searchSuggestion("a", semanticMatch("a-90", .90, 0), semanticMatch("a-70", .70, 1)),
	}

	if got := suggestionIDs(mergeHybridSuggestions(nil, nil, semantic)); !reflect.DeepEqual(got, []string{"b", "c", "a"}) {
		t.Fatalf("evidence profile order = %v", got)
	}
}

func TestHybridRankingUsesCorroborationInsideTheEvidenceBand(t *testing.T) {
	semantic := []suggestion{
		searchSuggestion("single", semanticMatch("single", .901, 0)),
		searchSuggestion("corroborated", semanticMatch("corroborated-1", .899, 0), semanticMatch("corroborated-2", .899, 1)),
	}

	if got := suggestionIDs(mergeHybridSuggestions(nil, nil, semantic)); !reflect.DeepEqual(got, []string{"corroborated", "single"}) {
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

	if got := suggestionIDs(mergeHybridSuggestions(nil, lexical, semantic)); !reflect.DeepEqual(got, []string{"river-bank", "literal-fragment"}) {
		t.Fatalf("partial lexical evidence overrode semantic intent: %v", got)
	}
}

func TestHybridRankingUsesAnswerabilityInsideSemanticScoreBand(t *testing.T) {
	semantic := []suggestion{
		searchSuggestion("display", semanticMatchWithAnswerability("display", .901, 0, semanticsearch.SemanticRoleHeading)),
		searchSuggestion("direct", semanticMatchWithAnswerability("direct", .899, 0, semanticsearch.SemanticRoleDefinition)),
	}

	if got := suggestionIDs(mergeHybridSuggestions(nil, nil, semantic)); !reflect.DeepEqual(got, []string{"direct", "display"}) {
		t.Fatalf("same-band answerability order = %v", got)
	}
}

func TestHybridRankingLetsSemanticRelevanceChooseBetweenDirectAndGuidance(t *testing.T) {
	semantic := []suggestion{
		searchSuggestion("direct", semanticMatchWithAnswerability("direct", .899, 0, semanticsearch.SemanticRoleDefinition)),
		searchSuggestion("guidance", semanticMatchWithAnswerability("guidance", .901, 0, semanticsearch.SemanticRoleGuidance)),
	}

	if got := suggestionIDs(mergeHybridSuggestions(nil, nil, semantic)); !reflect.DeepEqual(got, []string{"guidance", "direct"}) {
		t.Fatalf("query relevance did not choose between two answerable evidence kinds: %v", got)
	}
}

func TestHybridEvidenceShowsDirectExpressionBeforeSameBandGuidance(t *testing.T) {
	guidance := semanticMatchWithAnswerability("guidance", .901, 0, semanticsearch.SemanticRoleGuidance)
	direct := semanticMatchWithAnswerability("direct", .899, 1, semanticsearch.SemanticRoleDefinition)

	got := mergeSearchMatches(nil, []searchMatch{guidance, direct})
	if len(got) != 2 || got[0].EnglishText != "direct" {
		t.Fatalf("same-band guidance obscured a directly usable expression: %#v", got)
	}
}

func TestHybridEvidenceUsesExactASCIICoverageBeforeDirectGuidancePriority(t *testing.T) {
	direct := semanticMatchWithAnswerability("afraid before a noun", .899, 0, semanticsearch.SemanticRoleDefinition)
	guidance := semanticMatchWithAnswerability("afraid of or about", .901, 1, semanticsearch.SemanticRoleGuidance)

	got := mergeSearchMatches(searchtext.NewQueryProfile("afraid 能放名词前 of 还是 about"), []searchMatch{direct, guidance})
	if len(got) != 2 || got[0].EnglishText != "afraid of or about" {
		t.Fatalf("exact ASCII coverage did not promote the applicable rule: %#v", got)
	}
}

func TestHybridEvidenceDoesNotLetDisplayTokenCoverageHideAnAnswer(t *testing.T) {
	display := semanticMatchWithAnswerability("afraid of or about", .901, 0, semanticsearch.SemanticRoleHeading)
	direct := semanticMatchWithAnswerability("afraid before a noun", .899, 1, semanticsearch.SemanticRoleDefinition)

	got := mergeSearchMatches(searchtext.NewQueryProfile("afraid of or about"), []searchMatch{display, direct})
	if len(got) != 2 || got[0].semanticSemanticRole != semanticsearch.SemanticRoleDefinition {
		t.Fatalf("display token coverage hid answerable evidence: %#v", got)
	}
}

func TestHybridRankingKeepsHigherSemanticScoreBandAheadOfAnswerability(t *testing.T) {
	semantic := []suggestion{
		searchSuggestion("display", semanticMatchWithAnswerability("display", .906, 0, semanticsearch.SemanticRoleHeading)),
		searchSuggestion("direct", semanticMatchWithAnswerability("direct", .901, 0, semanticsearch.SemanticRoleDefinition)),
	}

	if got := suggestionIDs(mergeHybridSuggestions(nil, nil, semantic)); !reflect.DeepEqual(got, []string{"display", "direct"}) {
		t.Fatalf("higher semantic band was demoted by answerability: %v", got)
	}
}

func TestHybridEvidenceRetainsDirectEvidenceBeforeSameBandDisplayAtTheLimit(t *testing.T) {
	semantic := make([]searchMatch, 0, maxSearchMatches+1)
	for index := 0; index < maxSearchMatches; index++ {
		semantic = append(semantic, semanticMatchWithAnswerability("display-"+string(rune('a'+index)), .901, index, semanticsearch.SemanticRoleHeading))
	}
	semantic = append(semantic, semanticMatchWithAnswerability("direct", .899, maxSearchMatches, semanticsearch.SemanticRoleDefinition))

	merged := mergeSearchMatches(nil, semantic)
	if len(merged) != maxSearchMatches || merged[0].semanticSemanticRole != semanticsearch.SemanticRoleDefinition {
		t.Fatalf("same-band direct evidence was excluded at the evidence limit: %#v", merged)
	}
}

func TestHybridRankingUsesStableSemanticKeysAfterEquivalentEvidence(t *testing.T) {
	semantic := []suggestion{
		searchSuggestion("beta", semanticMatchWithAnswerability("beta", .90, 0, semanticsearch.SemanticRoleDefinition)),
		searchSuggestion("alpha", semanticMatchWithAnswerability("alpha", .90, 0, semanticsearch.SemanticRoleDefinition)),
	}
	for run := 0; run < 10; run++ {
		if got := suggestionIDs(mergeHybridSuggestions(nil, nil, semantic)); !reflect.DeepEqual(got, []string{"beta", "alpha"}) {
			t.Fatalf("unstable semantic tie order on run %d: %v", run, got)
		}
	}
}

func TestHybridEvidenceMergesSignalsAndRetainsAReadableBound(t *testing.T) {
	lexical := make([]searchMatch, 0, maxSearchMatches)
	semantic := make([]searchMatch, 0, maxSearchMatches)
	for index := 0; index < maxSearchMatches; index++ {
		lexical = append(lexical, lexicalMatch(string(rune('a'+index)), 1, index))
		semantic = append(semantic, semanticMatch(string(rune('a'+index)), .90-float32(index)/100, index))
	}
	merged := mergeSearchMatches(nil, lexical, semantic)
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
	forward := mergeSearchMatches(nil, []searchMatch{weak}, []searchMatch{strong})
	reverse := mergeSearchMatches(nil, []searchMatch{strong}, []searchMatch{weak})
	for _, merged := range [][]searchMatch{forward, reverse} {
		if len(merged) != 1 || merged[0].semanticScore != .91 || merged[0].semanticPosition != 2 {
			t.Fatalf("duplicate semantic signal was order-dependent: %#v", merged)
		}
	}
}

func TestHybridEvidenceShowsAnAnswerBeforeAnExactNavigationHeading(t *testing.T) {
	display := lexicalMatch("表示赞同", 4, 0)
	display.Scope = reversesearch.ScopeResource
	display.lexicalSemanticRole = reversesearch.SemanticRoleHeading
	direct := semanticMatchWithAnswerability("go along with sb", .88, 0, semanticsearch.SemanticRoleDefinition)
	direct.Scope = reversesearch.ScopeResource

	got := mergeSearchMatches(nil, []searchMatch{display}, []searchMatch{direct})
	if len(got) != 2 || got[0].EnglishText != "go along with sb" {
		t.Fatalf("navigation text hid an answerable usage expression: %#v", got)
	}
}

func TestHybridRankingShowsAnAnswerableEntryBeforeAnExactNavigationHeading(t *testing.T) {
	display := lexicalMatch("表示赞同", 4, 0)
	display.Scope = reversesearch.ScopeResource
	display.lexicalSemanticRole = reversesearch.SemanticRoleHeading
	direct := semanticMatchWithAnswerability("go along with sb", .88, 0, semanticsearch.SemanticRoleDefinition)
	direct.Scope = reversesearch.ScopeResource

	lexical := []suggestion{searchSuggestion("navigation", display)}
	semantic := []suggestion{searchSuggestion("answer", direct)}
	if got := suggestionIDs(mergeHybridSuggestions(nil, lexical, semantic)); !reflect.DeepEqual(got, []string{"answer", "navigation"}) {
		t.Fatalf("navigation entry hid an answerable entry: %v", got)
	}
}

func TestHybridEntryProtectionKeepsAnswersButRejectsNavigationAndIncidentalContext(t *testing.T) {
	display := lexicalMatch("表示赞同", 4, 0)
	display.Scope = reversesearch.ScopeResource
	display.lexicalSemanticRole = reversesearch.SemanticRoleHeading
	guidance := lexicalMatch("正式书面语", protectedLexicalTier, 0)
	guidance.Scope = reversesearch.ScopeResource
	guidance.lexicalSemanticRole = reversesearch.SemanticRoleGuidance
	context := lexicalMatch("在说明中表示赞同", protectedLexicalTier, 0)
	context.Scope = reversesearch.ScopeResource
	context.lexicalSemanticRole = reversesearch.SemanticRoleContext

	if !protectsLexicalResult(guidance) {
		t.Fatal("answerable usage guidance stopped protecting its canonical entry")
	}
	if protectsLexicalResult(display) {
		t.Fatal("navigation-only usage text protected an entry from answerable evidence")
	}
	if protectsLexicalResult(context) {
		t.Fatal("incidental usage prose protected an entry from semantic ranking")
	}
}

func TestHybridRankingPlacesHeadwordAnchorsBeforeNonAnchors(t *testing.T) {
	anchored := searchSuggestion("affect", lexicalMatch("影响", 1, 0))
	anchored.headwordAnchor = true
	anchored.headwordAnchorRank = 1
	nonAnchor := searchSuggestion("influence", semanticMatch("影响", .99, 0))

	got := suggestionIDs(mergeHybridSuggestions(searchtext.NewQueryProfile("affect 应该怎么用"), []suggestion{nonAnchor, anchored}, nil))
	if !reflect.DeepEqual(got, []string{"affect", "influence"}) {
		t.Fatalf("headword anchor did not precede non-anchor: %v", got)
	}
}

func TestHybridRankingUsesAnswerableEvidenceBeforeAnchorOrdinal(t *testing.T) {
	first := searchSuggestion("affect", semanticMatchWithAnswerability("generic effect", .899, 0, semanticsearch.SemanticRoleDefinition))
	first.headwordAnchor = true
	first.headwordAnchorRank = 0
	second := searchSuggestion("effect", semanticMatchWithAnswerability("affect or effect", .901, 0, semanticsearch.SemanticRoleGuidance))
	second.headwordAnchor = true
	second.headwordAnchorRank = 1

	got := suggestionIDs(mergeHybridSuggestions(searchtext.NewQueryProfile("affect effect 应该用哪个"), []suggestion{first, second}, nil))
	if !reflect.DeepEqual(got, []string{"effect", "affect"}) {
		t.Fatalf("answerable anchor evidence was overridden by query ordinal: %v", got)
	}
}

func TestHybridRankingUsesAnchorRankAfterEquivalentEvidence(t *testing.T) {
	first := searchSuggestion("affect", lexicalMatch("影响", 1, 5))
	first.headwordAnchor = true
	first.headwordAnchorRank = 0
	second := searchSuggestion("effect", lexicalMatch("作用", 1, 0))
	second.headwordAnchor = true
	second.headwordAnchorRank = 1

	got := suggestionIDs(mergeHybridSuggestions(searchtext.NewQueryProfile("affect effect 应该用哪个"), []suggestion{second, first}, nil))
	if !reflect.DeepEqual(got, []string{"affect", "effect"}) {
		t.Fatalf("equivalent anchors did not use anchor rank: %v", got)
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
		lexicalRelevance:    reversesearch.Relevance{Tier: tier},
		lexicalSemanticRole: reversesearch.SemanticRoleDefinition,
	}
}

func semanticMatch(chinese string, score float32, position int) searchMatch {
	return semanticMatchWithAnswerability(chinese, score, position, semanticsearch.SemanticRoleDefinition)
}

func semanticMatchWithAnswerability(chinese string, score float32, position int, answerability semanticsearch.SemanticRole) searchMatch {
	return searchMatch{
		Scope: reversesearch.ScopeSense, EnglishText: chinese, ChineseText: chinese,
		Location:             reversesearch.Location{Section: reversesearch.SectionDefinitions, OwnerID: chinese, Path: []string{chinese}},
		hasSemantic:          true,
		semanticPosition:     position,
		semanticScore:        score,
		semanticSemanticRole: answerability,
	}
}

func suggestionIDs(items []suggestion) []string {
	ids := make([]string, len(items))
	for index, item := range items {
		ids[index] = item.ID
	}
	return ids
}
