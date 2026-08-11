package searchtext

import (
	"reflect"
	"testing"
)

func TestQueryProfileAnchorsMeaningfulPhrasesAndTokens(t *testing.T) {
	profile := NewQueryProfile("on no account 是不是绝对不能的意思？")
	if got, want := profile.AllTerms(), []string{"on", "no", "account"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("AllTerms() = %#v, want %#v", got, want)
	}
	if got, want := profile.AnchorTerms(), []AnchorTerm{{Term: "on no account", Ordinal: 0}, {Term: "account", Ordinal: 1}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("AnchorTerms() = %#v, want %#v", got, want)
	}
}

func TestQueryProfileRetainsStandaloneFunctionWordsAndExactBoundaries(t *testing.T) {
	profile := NewQueryProfile("on 是什么意思")
	if got, want := profile.AnchorTerms(), []AnchorTerm{{Term: "on", Ordinal: 0}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("AnchorTerms() = %#v, want %#v", got, want)
	}
	if significant, all := profile.EvidenceHits("helper", "on"); significant != 1 || all != 1 {
		t.Fatalf("EvidenceHits() = (%d, %d), want (1, 1)", significant, all)
	}
	if got := NormalizeHeadwordTerm("Wi-Fi"); got != "wi-fi" {
		t.Fatalf("NormalizeHeadwordTerm() = %q", got)
	}
	if got, want := NormalizeHeadwordTerm("put ˈthrough"), "put through"; got != want {
		t.Fatalf("stress-marked phrase normalized to %q, want %q", got, want)
	}
	if got, want := NewQueryProfile("Wi-Fi 怎么写").AllTerms(), []string{"wi", "fi"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("hyphenated AllTerms() = %#v, want %#v", got, want)
	}
}

func TestQueryProfileDoesNotMatchTokenPrefixes(t *testing.T) {
	profile := NewQueryProfile("help 后面带不带 to")
	if significant, all := profile.EvidenceHits("helper", "to"); significant != 0 || all != 1 {
		t.Fatalf("EvidenceHits() = (%d, %d), want (0, 1)", significant, all)
	}
}

func TestQueryProfileDoesNotCreateASCIIFragmentsFromAccentedWords(t *testing.T) {
	profile := NewQueryProfile("café 是什么意思")
	if got := profile.AllTerms(); len(got) != 0 {
		t.Fatalf("accented word produced ASCII fragments: %#v", got)
	}
	if got := NormalizeHeadwordTerm("naïve"); got != "" {
		t.Fatalf("accented headword produced an unsafe exact term: %q", got)
	}
	if got, want := NewQueryProfile("DNA共同词").AllTerms(), []string{"dna"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("CJK boundary suppressed an ASCII token: got %#v, want %#v", got, want)
	}
}

func TestPhraseIndexTermsNormalizeDictionaryNotationWithoutPhraseSpecificRules(t *testing.T) {
	tests := []struct {
		input string
		want  []string
	}{
		{input: "ˌput sb ˈthrough (to sb/…)", want: []string{"put sb through to sb", "put sb through", "put through"}},
		{input: "who am ˈI, who are ˈyou, etc. to do sth?", want: []string{"who am i"}},
		{input: "be/go ˈoff the ˌdeep end", want: []string{"be off the deep end", "go off the deep end"}},
		{input: "(on the ˈone hand…) on the ˈother (hand)…", want: []string{"on the one hand", "on the other hand"}},
		{input: "close on| close to", want: []string{"close on", "close to"}},
	}
	for _, test := range tests {
		t.Run(test.input, func(t *testing.T) {
			got := PhraseIndexTerms(test.input)
			for _, wanted := range test.want {
				if !containsString(got, wanted) {
					t.Fatalf("PhraseIndexTerms(%q) = %#v, missing %q", test.input, got, wanted)
				}
			}
			if len(got) > maxPhraseIndexTerms {
				t.Fatalf("PhraseIndexTerms(%q) emitted %d keys", test.input, len(got))
			}
		})
	}
}

func TestPhraseMatchDistanceUsesSlotsAndOptionalGroups(t *testing.T) {
	query := "put me through"
	phone := PhraseMatchDistance(query, "ˌput sb ˈthrough (to sb/…)")
	thing := PhraseMatchDistance(query, "ˌput sth↔ˈthrough")
	extraObject := PhraseMatchDistance(query, "ˌput sb ˈthrough sth")
	if phone != 0 || phone >= thing || phone >= extraObject {
		t.Fatalf("distances phone=%d thing=%d extraObject=%d", phone, thing, extraObject)
	}
	if got := PhraseMatchDistance("go off the deep end", "be/go ˈoff the ˌdeep end"); got != 0 {
		t.Fatalf("slash alternative distance = %d, want 0", got)
	}
	if got := PhraseMatchDistance("on the other hand", "(on the ˈone hand…) on the ˈother (hand)…"); got != 0 {
		t.Fatalf("ellipsis-separated alternative distance = %d, want 0", got)
	}
}

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}
