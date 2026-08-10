package server_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"sync/atomic"
	"testing"

	"dictionary-api/internal/semanticsearch"
)

type fakeSemanticSearcher struct {
	page  semanticsearch.Page
	err   error
	calls atomic.Int32
}

func (searcher *fakeSemanticSearcher) Search(_ context.Context, _ string, _ semanticsearch.Options) (semanticsearch.Page, error) {
	searcher.calls.Add(1)
	return searcher.page, searcher.err
}

func TestSemanticSearchOnlyRunsForEligibleHybridChineseQueries(t *testing.T) {
	searcher := &fakeSemanticSearcher{page: semanticsearch.Page{Groups: []semanticsearch.Group{{EntryID: "one"}}}}
	service := newFixtureServiceWithReverseSearchAndSemantic(t, searcher)

	for _, target := range []string{
		"/api/v1/search?q=%E7%B2%BE%E7%A1%AE%E9%87%8A%E4%B9%89",
		"/api/v1/search?q=%E4%B8%AD&mode=hybrid",
		"/api/v1/search?q=alpha&mode=hybrid",
	} {
		response := get(t, service, target)
		if response.Code != http.StatusOK {
			t.Fatalf("%s: %d %s", target, response.Code, response.Body.String())
		}
	}
	if calls := searcher.calls.Load(); calls != 0 {
		t.Fatalf("ineligible/default search called semantic provider %d times", calls)
	}

	response := get(t, service, "/api/v1/search?q=%E7%B2%BE%E7%A1%AE%E9%87%8A%E4%B9%89&mode=hybrid")
	if response.Code != http.StatusOK || searcher.calls.Load() != 1 {
		t.Fatalf("eligible hybrid search: status=%d calls=%d body=%s", response.Code, searcher.calls.Load(), response.Body.String())
	}
}

func TestSemanticProviderFailureFallsBackToCompleteLexicalPage(t *testing.T) {
	searcher := &fakeSemanticSearcher{err: errors.New("provider rate limited")}
	service := newFixtureServiceWithReverseSearchAndSemantic(t, searcher)
	lexical := get(t, service, "/api/v1/search?q=%E9%87%8A%E4%B9%89&limit=10")
	hybrid := get(t, service, "/api/v1/search?q=%E9%87%8A%E4%B9%89&limit=10&mode=hybrid")
	if lexical.Code != http.StatusOK || hybrid.Code != http.StatusOK {
		t.Fatalf("lexical=%d hybrid=%d", lexical.Code, hybrid.Code)
	}
	if got, want := searchIDs(t, hybrid), searchIDs(t, lexical); !reflect.DeepEqual(got, want) {
		t.Fatalf("failed semantic lookup changed lexical page: got=%v want=%v", got, want)
	}
	if searcher.calls.Load() != 1 {
		t.Fatalf("provider calls = %d, want 1", searcher.calls.Load())
	}
}

func TestHybridSearchDeduplicatesProtectsExactLexicalAndPaginatesStably(t *testing.T) {
	searcher := &fakeSemanticSearcher{page: semanticsearch.Page{Groups: []semanticsearch.Group{
		{EntryID: "one"}, {EntryID: "exact"}, {EntryID: "one"},
	}}}
	service := newFixtureServiceWithReverseSearchAndSemantic(t, searcher)
	target := "/api/v1/search?q=%E7%B2%BE%E7%A1%AE%E9%87%8A%E4%B9%89&mode=hybrid&limit=1"
	first := get(t, service, target)
	repeated := get(t, service, target)
	if first.Code != http.StatusOK || first.Body.String() != repeated.Body.String() {
		t.Fatalf("hybrid responses are unstable: first=%d %s repeated=%d %s", first.Code, first.Body.String(), repeated.Code, repeated.Body.String())
	}
	if got := searchIDs(t, first); !reflect.DeepEqual(got, []string{"exact"}) {
		t.Fatalf("exact lexical result was not protected: %v", got)
	}
	second := get(t, service, target+"&offset=1")
	if second.Code != http.StatusOK || !reflect.DeepEqual(searchIDs(t, second), []string{"one"}) {
		t.Fatalf("unexpected second hybrid page: %d %s", second.Code, second.Body.String())
	}
}

func TestHybridEvidenceIsDeduplicatedAndBounded(t *testing.T) {
	shared := semanticsearch.Match{
		Scope: semanticsearch.ScopeSense, English: "exact definition", Chinese: "精确释义",
		Location: semanticsearch.Location{Section: "definitions", Part: "noun", OwnerID: "sense-exact", Path: []string{"senses", "0"}},
	}
	searcher := &fakeSemanticSearcher{page: semanticsearch.Page{Groups: []semanticsearch.Group{{
		EntryID: "exact",
		Matches: []semanticsearch.Match{
			shared,
			{Scope: semanticsearch.ScopePhrase, English: "second", Chinese: "第二条", Location: semanticsearch.Location{Section: "idioms", Path: []string{"idioms", "0"}}},
			{Scope: semanticsearch.ScopeUsage, English: "third", Chinese: "第三条", Location: semanticsearch.Location{Section: "grammar-usage", Path: []string{"usage", "0"}}},
		},
	}}}}
	service := newFixtureServiceWithReverseSearchAndSemantic(t, searcher)
	response := get(t, service, "/api/v1/search?q=%E7%B2%BE%E7%A1%AE%E9%87%8A%E4%B9%89&mode=hybrid")
	if response.Code != http.StatusOK {
		t.Fatalf("hybrid response: %d %s", response.Code, response.Body.String())
	}
	var body struct {
		Items []struct {
			Matches []json.RawMessage `json:"matches"`
		} `json:"items"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || len(body.Items) == 0 || len(body.Items[0].Matches) != 3 {
		t.Fatalf("hybrid evidence contract: %#v, %v", body, err)
	}
}

func TestHealthReportsSemanticSearchCapability(t *testing.T) {
	searcher := &fakeSemanticSearcher{}
	service := newFixtureServiceWithReverseSearchAndSemantic(t, searcher)
	response := get(t, service, "/api/v1/health")
	var body struct {
		Capabilities struct {
			SemanticSearch bool `json:"semanticSearch"`
		} `json:"capabilities"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &body) != nil || !body.Capabilities.SemanticSearch {
		t.Fatalf("semantic health capability: %d %s", response.Code, response.Body.String())
	}
}
