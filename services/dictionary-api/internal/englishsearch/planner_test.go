package englishsearch

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
)

type fakeResolver struct {
	results Results
	request Request
	calls   int
}

func (f *fakeResolver) ResolveEnglishSearch(_ context.Context, request Request) (Results, error) {
	f.calls++
	f.request = request
	return f.results, nil
}

func TestPlannerBusinessCases(t *testing.T) {
	tests := []struct {
		name       string
		query      string
		submitted  bool
		results    Results
		wantExact  []MatchKind
		wantPhrase []string
		wantTokens []string
		wantTypo   string
		wantProbe  string
	}{
		{
			name:      "independent thought precedes think inflection",
			query:     "thought",
			submitted: true,
			results: Results{Exact: []Match{
				{Headword: "think", Kind: MatchInflection, Relation: "think"},
				{Headword: "thought", Kind: MatchHeadword},
			}},
			wantExact:  []MatchKind{MatchHeadword, MatchInflection},
			wantTokens: nil,
		},
		{
			name:  "independent frightened adjective precedes frighten relation",
			query: "frightened",
			results: Results{Exact: []Match{
				{Headword: "frighten", Kind: MatchInflection, Relation: "frighten"},
				{Headword: "frightened", Kind: MatchHeadword},
			}},
			wantExact: []MatchKind{MatchHeadword, MatchInflection},
		},
		{
			name:      "independent frightening entry does not expand to a sibling form",
			query:     "frightening",
			results:   Results{Exact: []Match{{Headword: "frightening", Kind: MatchHeadword}}},
			wantExact: []MatchKind{MatchHeadword},
		},
		{
			name:      "longest phrase removes covered submitted words",
			query:     "Could you put me through?",
			submitted: true,
			results: Results{Phrases: map[string][]Match{
				"put through": {{Headword: "put through", Kind: MatchPhrase}},
			}},
			wantPhrase: []string{"put through"},
			wantProbe:  "put through",
		},
		{
			name:      "exact phrase is not repeated as a secondary phrase",
			query:     "break the ice",
			submitted: true,
			results: Results{
				Exact: []Match{{Headword: "ice", Kind: MatchPhrase}},
				Phrases: map[string][]Match{
					"break the ice": {{Headword: "ice", Kind: MatchPhrase}},
				},
			},
			wantExact: []MatchKind{MatchPhrase},
			wantProbe: "break the ice",
		},
		{
			name:  "teh is an explicit suggestion",
			query: "teh",
			results: Results{Corrections: map[string][]Match{
				"the": {{Headword: "the", Kind: MatchHeadword}},
			}},
			wantTypo:  "the",
			wantProbe: "the",
		},
		{
			name:  "valid term suppresses correction",
			query: "sough",
			results: Results{
				Exact:       []Match{{Headword: "sough", Kind: MatchHeadword}},
				Corrections: map[string][]Match{"sought": {{Headword: "sought", Kind: MatchHeadword}}},
			},
			wantExact: []MatchKind{MatchHeadword},
		},
		{
			name:       "sentence without phrase keeps informative submitted words",
			query:      "A bright window reflects light.",
			submitted:  true,
			wantTokens: []string{"bright", "window", "reflects", "light"},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			resolver := &fakeResolver{results: test.results}
			plan, err := New(Options{}).Plan(context.Background(), test.query, test.submitted, resolver)
			if err != nil {
				t.Fatal(err)
			}
			if plan.Query != strings.ToLower(strings.Trim(strings.TrimSpace(test.query), "?!.")) {
				t.Fatalf("plan query = %q", plan.Query)
			}
			if got := kinds(plan.Exact.Matches); !reflect.DeepEqual(got, test.wantExact) {
				t.Fatalf("exact kinds = %v, want %v", got, test.wantExact)
			}
			if got := groupTexts(plan.Phrases); !reflect.DeepEqual(got, test.wantPhrase) {
				t.Fatalf("phrases = %v, want %v", got, test.wantPhrase)
			}
			if got := groupTexts(plan.Tokens); !reflect.DeepEqual(got, test.wantTokens) {
				t.Fatalf("tokens = %v, want %v", got, test.wantTokens)
			}
			if test.wantTypo == "" && plan.Correction != nil {
				t.Fatalf("unexpected correction %#v", plan.Correction)
			}
			if test.wantTypo != "" && (plan.Correction == nil || plan.Correction.Suggestion != test.wantTypo) {
				t.Fatalf("correction = %#v, want %q", plan.Correction, test.wantTypo)
			}
			if test.wantProbe != "" && !containsProbe(resolver.request, test.wantProbe) {
				t.Fatalf("batch request did not include %q: %#v", test.wantProbe, resolver.request)
			}
		})
	}
}

func TestSubmittedSingleWordDoesNotRepeatItsExactGroupAsAToken(t *testing.T) {
	request, err := New(Options{}).BuildRequest("thought", true)
	if err != nil {
		t.Fatal(err)
	}
	if len(request.TokenProbes) != 0 {
		t.Fatalf("single-word token probes = %#v, want none", request.TokenProbes)
	}
}

func TestPlannerSubmitControlsSecondaryTokens(t *testing.T) {
	resolver := &fakeResolver{}
	plan, err := New(Options{}).Plan(context.Background(), "find a quiet room", false, resolver)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Phrases) != 0 || len(plan.Tokens) != 0 || len(resolver.request.PhraseProbes) != 0 || len(resolver.request.TokenProbes) != 0 {
		t.Fatalf("non-submitted query produced secondary terms: %#v / %#v", plan.Tokens, resolver.request.TokenProbes)
	}
}

func TestPhrasePlanningPreservesStopWordsAndAddsSeparableAlternative(t *testing.T) {
	planner := New(Options{})
	request, err := planner.BuildRequest("By and large, they put me through.", true)
	if err != nil {
		t.Fatal(err)
	}
	for _, wanted := range []string{"by and large", "put me through", "put through"} {
		if !containsProbe(request, wanted) {
			t.Fatalf("phrase probes did not include %q: %#v", wanted, request.PhraseProbes)
		}
	}
}

func TestPhrasePlanningSkipsFunctionWordOnlyFragments(t *testing.T) {
	request, err := New(Options{}).BuildRequest("who am I to do this?", true)
	if err != nil {
		t.Fatal(err)
	}
	if !containsProbe(request, "who am i") {
		t.Fatalf("meaningful phrase was omitted: %#v", request.PhraseProbes)
	}
	if containsProbe(request, "to do") {
		t.Fatalf("function-word-only phrase was emitted: %#v", request.PhraseProbes)
	}
}

func TestPhrasePlanningRanksTheMatchingDictionaryPatternFirst(t *testing.T) {
	resolver := &fakeResolver{results: Results{Phrases: map[string][]Match{
		"put through": {
			{Headword: "put", Kind: MatchPhrase, Location: Location{OwnerID: "thing"}, Evidence: &Evidence{CandidateText: "put sth through"}},
			{Headword: "put", Kind: MatchPhrase, Location: Location{OwnerID: "phone"}, Evidence: &Evidence{CandidateText: "put sb through (to sb/…)"}},
			{Headword: "put", Kind: MatchPhrase, Location: Location{OwnerID: "experience"}, Evidence: &Evidence{CandidateText: "put sb through sth"}},
		},
	}}}
	plan, err := New(Options{}).Plan(context.Background(), "Could you put me through?", true, resolver)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Phrases) == 0 || len(plan.Phrases[0].Matches) != 3 {
		t.Fatalf("phrase plan = %#v", plan.Phrases)
	}
	if got := plan.Phrases[0].Matches[0].Evidence.CandidateText; got != "put sb through (to sb/…)" {
		t.Fatalf("first phrase evidence = %q", got)
	}
}

func TestZeroValuePlannerUsesDefaultBounds(t *testing.T) {
	var planner Planner
	resolver := &fakeResolver{}
	plan, err := planner.Plan(context.Background(), "alpha beta gamma", true, resolver)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Phrases)+len(plan.Tokens) > DefaultMaxGroups-1 {
		t.Fatalf("zero-value planner exceeded default group cap: %#v", plan)
	}
}

func TestBuildRequestNormalizesApostrophesHyphensDuplicatesAndBounds(t *testing.T) {
	planner := New(Options{MaxPhraseProbes: 2, MaxCorrectionProbes: 3})
	request, err := planner.BuildRequest("The the O’Connor’s well-being well-being!", true)
	if err != nil {
		t.Fatal(err)
	}
	if request.Exact != "the the o'connor's well-being well-being" {
		t.Fatalf("exact = %q", request.Exact)
	}
	if got, want := probeTexts(request.TokenProbes), []string{"o'connor's", "well-being"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("token probes = %v, want %v", got, want)
	}
	if len(request.PhraseProbes) > 2 || len(request.CorrectionProbes) > 3 {
		t.Fatalf("unbounded request %#v", request)
	}
}

func TestBuildRequestRejectsUnboundedInput(t *testing.T) {
	if _, err := New(Options{MaxQueryRunes: 4}).BuildRequest("abcde", true); !errors.Is(err, ErrQueryLong) {
		t.Fatalf("long query error = %v", err)
	}
	request, err := New(Options{MaxQueryRunes: 20, MaxTokens: 2}).BuildRequest("one two three", true)
	if err != nil || !request.Truncated || len(request.TokenProbes) > 2 {
		t.Fatalf("many-token query was not bounded: %#v, %v", request, err)
	}
}

func TestPlannerAnyExactDictionaryEvidenceSuppressesCorrection(t *testing.T) {
	for _, kind := range []MatchKind{MatchHeadword, MatchVariant, MatchPhrase, MatchPattern, MatchEtymology, MatchInflection} {
		t.Run(string(kind), func(t *testing.T) {
			resolver := &fakeResolver{results: Results{
				Exact:       []Match{{Headword: "sough", Kind: kind}},
				Corrections: map[string][]Match{"sought": {{Headword: "sought", Kind: MatchHeadword}}},
			}}
			plan, err := New(Options{}).Plan(context.Background(), "sough", true, resolver)
			if err != nil {
				t.Fatal(err)
			}
			if plan.Correction != nil {
				t.Fatalf("valid %s produced correction %#v", kind, plan.Correction)
			}
		})
	}
}

func TestPlannerLimitsGroupsAndUsesSingleBatch(t *testing.T) {
	resolver := &fakeResolver{results: Results{Phrases: map[string][]Match{
		"alpha beta": {{Headword: "alpha beta", Kind: MatchPhrase}},
	}}}
	plan, err := New(Options{MaxGroups: 2}).Plan(context.Background(), "alpha beta gamma delta", true, resolver)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Phrases)+len(plan.Tokens) > 1 {
		t.Fatalf("too many secondary groups: %#v", plan)
	}
	if len(resolver.request.PhraseProbes) > hardMaxPhraseProbes {
		t.Fatalf("too many phrase probes: %d", len(resolver.request.PhraseProbes))
	}
	if resolver.calls != 1 {
		t.Fatalf("resolver calls = %d, want one batch", resolver.calls)
	}
}

func kinds(matches []Match) []MatchKind {
	if len(matches) == 0 {
		return nil
	}
	values := make([]MatchKind, len(matches))
	for index, match := range matches {
		values[index] = match.Kind
	}
	return values
}

func groupTexts(groups []Group) []string {
	if len(groups) == 0 {
		return nil
	}
	values := make([]string, len(groups))
	for index, group := range groups {
		values[index] = group.Text
	}
	return values
}

func probeTexts(probes []TokenProbe) []string {
	values := make([]string, len(probes))
	for index, probe := range probes {
		values[index] = probe.Text
	}
	return values
}

func containsProbe(request Request, text string) bool {
	for _, probe := range request.PhraseProbes {
		if probe.Text == text {
			return true
		}
	}
	for _, probe := range request.CorrectionProbes {
		if probe == text {
			return true
		}
	}
	return false
}
