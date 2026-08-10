package server_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"path/filepath"
	"reflect"
	"testing"

	"dictionary-api/internal/importer"
	"dictionary-api/internal/payload"
	"dictionary-api/internal/reversesearch"
	"dictionary-api/internal/schema"
	"dictionary-api/internal/server"
	_ "modernc.org/sqlite"
)

func TestChineseReverseSearchReturnsGroupedEvidenceWithoutChangingEnglishSearch(t *testing.T) {
	service := newFixtureServiceWithReverseSearch(t)
	response := get(t, service, "/api/v1/search?q=%E7%B2%BE%E7%A1%AE%E9%87%8A%E4%B9%89&limit=10")
	if response.Code != http.StatusOK {
		t.Fatalf("Chinese search: %d %s", response.Code, response.Body.String())
	}
	var result struct {
		Items []struct {
			ID            string   `json:"id"`
			HeadwordForms []string `json:"headwordForms"`
			Matches []struct {
				Scope       string                 `json:"scope"`
				EnglishText string                 `json:"englishText"`
				ChineseText string                 `json:"chineseText"`
				Location    reversesearch.Location `json:"location"`
			} `json:"matches"`
		} `json:"items"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Items) != 1 || result.Items[0].ID != "exact" || len(result.Items[0].Matches) != 1 {
		t.Fatalf("unexpected reverse-search result: %#v", result.Items)
	}
	if !reflect.DeepEqual(result.Items[0].HeadwordForms, []string{"alphas"}) {
		t.Fatalf("headword forms = %#v", result.Items[0].HeadwordForms)
	}
	match := result.Items[0].Matches[0]
	if match.Scope != "sense" || match.EnglishText != "exact definition" || match.ChineseText != "精确释义" || match.Location.OwnerID != "sense-exact" {
		t.Fatalf("unexpected search evidence: %#v", match)
	}
	if got := searchIDs(t, get(t, service, "/api/v1/search?q=alpha&limit=3")); len(got) != 3 || got[0] != "exact" {
		t.Fatalf("English search changed: %#v", got)
	}
}

func TestChineseReverseSearchReturnsStructuredPhraseEvidence(t *testing.T) {
	service := newFixtureServiceWithReverseSearch(t)
	response := get(t, service, "/api/v1/search?q=%E5%8F%A6%E4%B8%80%E4%B8%AA%E9%87%8A%E4%B9%89&limit=10")
	var result struct {
		Items []struct {
			Matches []struct {
				Scope          string `json:"scope"`
				CandidateText  string `json:"candidateText"`
				DefinitionText string `json:"definitionText"`
				Part           string `json:"part"`
			} `json:"matches"`
		} `json:"items"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &result) != nil || len(result.Items) != 1 || len(result.Items[0].Matches) != 1 {
		t.Fatalf("structured phrase response: %d %s", response.Code, response.Body.String())
	}
	match := result.Items[0].Matches[0]
	if match.Scope != "phrase" || match.CandidateText != "useful phrase" || match.DefinitionText != "a helpful expression" || match.Part != "verb" {
		t.Fatalf("structured phrase evidence = %#v", match)
	}
}

func TestChineseSearchReportsWhenOptionalSidecarIsAbsent(t *testing.T) {
	service, _ := newFixtureService(t)
	response := get(t, service, "/api/v1/search?q=%E4%B8%AD%E6%96%87&limit=10")
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("search without sidecar: %d %s", response.Code, response.Body.String())
	}
	var failure struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &failure); err != nil || failure.Error.Code != "reverse_search_unavailable" {
		t.Fatalf("search without sidecar returned an unstable error: %#v, %v", failure, err)
	}
}

func TestHealthReportsReverseSearchCapability(t *testing.T) {
	fixtures := []struct {
		name      string
		service   func(testing.TB) *server.Service
		available bool
	}{
		{name: "absent", service: func(t testing.TB) *server.Service { service, _ := newFixtureService(t); return service }},
		{name: "present", service: newFixtureServiceWithReverseSearch, available: true},
	}
	for _, fixture := range fixtures {
		t.Run(fixture.name, func(t *testing.T) {
			response := get(t, fixture.service(t), "/api/v1/health")
			var health struct {
				Capabilities struct {
					ChineseReverseSearch bool `json:"chineseReverseSearch"`
				} `json:"capabilities"`
			}
			if response.Code != http.StatusOK {
				t.Fatalf("health: %d %s", response.Code, response.Body.String())
			}
			if err := json.Unmarshal(response.Body.Bytes(), &health); err != nil || health.Capabilities.ChineseReverseSearch != fixture.available {
				t.Fatalf("health capability = %#v, %v", health, err)
			}
		})
	}
}

func TestChineseSearchReturnsIncrementalResultPages(t *testing.T) {
	service := newFixtureServiceWithReverseSearch(t)
	firstResponse := get(t, service, "/api/v1/search?q=%E9%87%8A%E4%B9%89&limit=1")
	if firstResponse.Code != http.StatusOK {
		t.Fatalf("first page: %d %s", firstResponse.Code, firstResponse.Body.String())
	}
	var first struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
		NextOffset *int `json:"nextOffset"`
	}
	if err := json.Unmarshal(firstResponse.Body.Bytes(), &first); err != nil {
		t.Fatal(err)
	}
	if len(first.Items) != 1 || first.NextOffset == nil || *first.NextOffset != 1 {
		t.Fatalf("unexpected first page: %#v", first)
	}

	secondResponse := get(t, service, "/api/v1/search?q=%E9%87%8A%E4%B9%89&limit=1&offset=1")
	var second struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
		NextOffset *int `json:"nextOffset"`
	}
	if err := json.Unmarshal(secondResponse.Body.Bytes(), &second); err != nil {
		t.Fatal(err)
	}
	if secondResponse.Code != http.StatusOK || len(second.Items) != 1 || second.NextOffset != nil || second.Items[0].ID == first.Items[0].ID {
		t.Fatalf("unexpected second page: %d %#v", secondResponse.Code, second)
	}
}

func TestChineseSearchRejectsUnboundedWindows(t *testing.T) {
	service := newFixtureServiceWithReverseSearch(t)
	for _, target := range []string{
		"/api/v1/search?q=%E9%87%8A%E4%B9%89&limit=257",
		"/api/v1/search?q=%E9%87%8A%E4%B9%89&offset=512",
	} {
		if response := get(t, service, target); response.Code != http.StatusBadRequest {
			t.Errorf("%s: got %d", target, response.Code)
		}
	}
}

func TestSearchScopeValidationDefaultsAndDeduplication(t *testing.T) {
	service := newFixtureServiceWithReverseSearch(t)
	usageQuery := url.QueryEscape("用法释义")
	if response := get(t, service, "/api/v1/search?q="+usageQuery); response.Code != http.StatusOK || len(searchIDs(t, response)) != 0 {
		t.Fatalf("default scopes included usage: %d %s", response.Code, response.Body.String())
	}
	response := get(t, service, "/api/v1/search?q="+usageQuery+"&scope=usage,usage")
	if response.Code != http.StatusOK {
		t.Fatalf("deduplicated scope: %d %s", response.Code, response.Body.String())
	}
	var scoped struct {
		Items []struct {
			ID      string `json:"id"`
			Matches []struct {
				Scope string `json:"scope"`
			} `json:"matches"`
		} `json:"items"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &scoped); err != nil {
		t.Fatal(err)
	}
	if len(scoped.Items) != 1 || scoped.Items[0].ID != "exact" || len(scoped.Items[0].Matches) != 1 || scoped.Items[0].Matches[0].Scope != "usage" {
		t.Fatalf("scoped response = %#v", scoped)
	}

	invalidTargets := []string{
		"/api/v1/search?q=" + usageQuery + "&scope=",
		"/api/v1/search?q=" + usageQuery + "&scope=unknown",
		"/api/v1/search?q=" + usageQuery + "&scope=sense,",
		"/api/v1/search?q=" + usageQuery + "&scope=sense&scope=phrase",
		"/api/v1/search?q=alpha&scope=sense",
	}
	for _, target := range invalidTargets {
		response := get(t, service, target)
		if response.Code != http.StatusBadRequest {
			t.Errorf("%s: got %d %s", target, response.Code, response.Body.String())
			continue
		}
		var failure struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &failure); err != nil || failure.Error.Code != "invalid_scope" {
			t.Errorf("%s: unstable error %#v, %v", target, failure, err)
		}
	}
}

func newFixtureServiceWithReverseSearch(t testing.TB) *server.Service {
	return newFixtureServiceWithReverseSearchAndSemantic(t, nil)
}

func newFixtureServiceWithReverseSearchAndSemantic(t testing.TB, semantic server.SemanticSearcher) *server.Service {
	t.Helper()
	directory := t.TempDir()
	sourcePath := filepath.Join(directory, "source.db")
	createSource(t, sourcePath)
	runtimePath := filepath.Join(directory, "runtime.db")
	if err := importer.Import(context.Background(), importer.Config{
		SourcePath: sourcePath, TargetPath: runtimePath, SourceVersion: "fixture-v1",
	}); err != nil {
		t.Fatal(err)
	}

	documents := []reversesearch.SearchDocument{
			{
				DictionaryID: "fixture", EntryID: "exact", Scope: reversesearch.ScopeSense,
				Headword: "alpha", EnglishText: "exact definition", ChineseText: "精确释义",
				HeadwordForms: []string{"alphas"},
			Location: reversesearch.Location{Section: reversesearch.SectionDefinitions, Part: "noun", OwnerID: "sense-exact", Path: []string{"senses", "0"}}, Weight: 100,
		},
		{
			DictionaryID: "fixture", EntryID: "exact", Scope: reversesearch.ScopeUsage,
			Headword: "alpha", EnglishText: "usage note", ChineseText: "用法释义",
			Location: reversesearch.Location{Section: reversesearch.SectionGrammarUsage, OwnerID: "usage-exact", Path: []string{"usage", "0"}}, Weight: 60,
		},
		{
			DictionaryID: "fixture", EntryID: "exact", Scope: reversesearch.ScopeExample,
			Headword: "alpha", EnglishText: "example sentence", ChineseText: "例句释义",
			Location: reversesearch.Location{Section: reversesearch.SectionDefinitions, OwnerID: "example-exact", Path: []string{"examples", "0"}}, Weight: 30,
		},
		{
			DictionaryID: "fixture", EntryID: "one", Scope: reversesearch.ScopePhrase,
			Headword: "Alpha able", EnglishText: "useful phrase a helpful expression",
			CandidateText: "useful phrase", DefinitionText: "a helpful expression", ChineseText: "另一个释义",
			Location: reversesearch.Location{Section: reversesearch.SectionIdioms, Part: "verb", OwnerID: "phrase-one", Path: []string{"idioms", "0"}}, Weight: 100,
		},
	}
	var projection bytes.Buffer
	encoder := json.NewEncoder(&projection)
	for _, document := range documents {
		if err := encoder.Encode(document); err != nil {
			t.Fatal(err)
		}
	}
	reversePath := filepath.Join(directory, "reverse.db")
	if err := reversesearch.Import(context.Background(), reversesearch.ImportConfig{
		Documents: &projection, DictionaryPath: runtimePath, TargetPath: reversePath,
		SourceVersion: "fixture-v1", ProjectionVersion: reversesearch.ProjectionVersion,
	}); err != nil {
		t.Fatal(err)
	}
	fingerprint, err := reversesearch.FileSHA256(runtimePath)
	if err != nil {
		t.Fatal(err)
	}
	reverseStore, err := reversesearch.Open(reversePath, fingerprint)
	if err != nil {
		t.Fatal(err)
	}

	db, err := sql.Open("sqlite", "file:"+runtimePath+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	codecName, dictionary, err := schema.PayloadSettings(db)
	if err != nil {
		t.Fatal(err)
	}
	codec, known, err := payload.ByName(codecName, dictionary)
	if err != nil || !known {
		t.Fatalf("payload codec: known=%t err=%v", known, err)
	}
	service := server.New(db, nil, server.Config{
		SourceVersion: "fixture-v1", PayloadCodec: codec, ReverseSearch: reverseStore,
		SemanticSearch: semantic, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	t.Cleanup(func() {
		if err := service.Close(); err != nil {
			t.Error(err)
		}
	})
	return service
}
