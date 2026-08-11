package server_test

import (
	"bytes"
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
	scope string
	calls atomic.Int32
}

func (searcher *fakeSemanticSearcher) Search(_ context.Context, _ string, options semanticsearch.Options) (semanticsearch.Page, error) {
	searcher.calls.Add(1)
	searcher.scope = options.Scopes.String()
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
	var body struct {
		SemanticStatus string `json:"semanticStatus"`
	}
	if json.Unmarshal(response.Body.Bytes(), &body) != nil || body.SemanticStatus != "applied" {
		t.Fatalf("successful hybrid status = %#v", body)
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
	var body struct {
		SemanticStatus string `json:"semanticStatus"`
	}
	if json.Unmarshal(hybrid.Body.Bytes(), &body) != nil || body.SemanticStatus != "degraded" {
		t.Fatalf("fallback status = %#v", body)
	}
}

func TestHybridSearchPassesTheValidatedSelectedScopeToSemanticSearch(t *testing.T) {
	searcher := &fakeSemanticSearcher{page: semanticsearch.Page{Groups: []semanticsearch.Group{}}}
	service := newFixtureServiceWithReverseSearchAndSemantic(t, searcher)
	response := get(t, service, "/api/v1/search?q=%E6%89%A9%E5%B1%95%E9%87%8A%E4%B9%89&mode=hybrid&scope=resource")
	if response.Code != http.StatusOK {
		t.Fatalf("resource-only hybrid search: %d %s", response.Code, response.Body.String())
	}
	if searcher.scope != "resource" {
		t.Fatalf("semantic scope = %q, want resource", searcher.scope)
	}
}

func TestMissingSemanticRuntimeReportsLexicalFallback(t *testing.T) {
	service := newFixtureServiceWithReverseSearch(t)
	lexical := get(t, service, "/api/v1/search?q=%E9%87%8A%E4%B9%89&limit=10")
	hybrid := get(t, service, "/api/v1/search?q=%E9%87%8A%E4%B9%89&limit=10&mode=hybrid")
	if lexical.Code != http.StatusOK || hybrid.Code != http.StatusOK {
		t.Fatalf("lexical=%d hybrid=%d", lexical.Code, hybrid.Code)
	}
	if got, want := searchIDs(t, hybrid), searchIDs(t, lexical); !reflect.DeepEqual(got, want) {
		t.Fatalf("missing semantic runtime changed lexical page: got=%v want=%v", got, want)
	}
	var body struct {
		SemanticStatus string `json:"semanticStatus"`
	}
	if json.Unmarshal(hybrid.Body.Bytes(), &body) != nil || body.SemanticStatus != "degraded" {
		t.Fatalf("missing runtime status = %#v", body)
	}
}

func TestHybridNoAnswerReturnsAStableEmptyPage(t *testing.T) {
	searcher := &fakeSemanticSearcher{page: semanticsearch.Page{Groups: []semanticsearch.Group{}}}
	service := newFixtureServiceWithReverseSearchAndSemantic(t, searcher)
	target := "/api/v1/search?q=%E4%B8%8D%E5%AD%98%E5%9C%A8%E7%9A%84%E9%87%8A%E4%B9%89&mode=hybrid&limit=10"
	first := get(t, service, target)
	second := get(t, service, target)
	if first.Code != http.StatusOK || second.Code != http.StatusOK || first.Body.String() != second.Body.String() {
		t.Fatalf("no-answer hybrid page is unstable: first=%d %s second=%d %s", first.Code, first.Body.String(), second.Code, second.Body.String())
	}
	if got := searchIDs(t, first); len(got) != 0 || searcher.calls.Load() != 2 {
		t.Fatalf("no-answer page = %v calls=%d", got, searcher.calls.Load())
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
		SemanticRole: semanticsearch.SemanticRoleDefinition,
		Location:     semanticsearch.Location{Section: "definitions", Part: "noun", OwnerID: "sense-exact", Path: []string{"senses", "0"}},
	}
	searcher := &fakeSemanticSearcher{page: semanticsearch.Page{Groups: []semanticsearch.Group{{
		EntryID: "exact",
		Matches: []semanticsearch.Match{
			shared,
			{Scope: semanticsearch.ScopePhrase, SemanticRole: semanticsearch.SemanticRoleDefinition, English: "second", Chinese: "第二条", Location: semanticsearch.Location{Section: "idioms", Path: []string{"idioms", "0"}}},
			{Scope: semanticsearch.ScopeResource, SemanticRole: semanticsearch.SemanticRoleGuidance, English: "third", Chinese: "第三条", Location: semanticsearch.Location{Section: "grammar-usage", Path: []string{"usage", "0"}}},
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
	if bytes.Contains(response.Body.Bytes(), []byte("answerability")) {
		t.Fatalf("internal semantic answerability leaked into HTTP JSON: %s", response.Body.String())
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
