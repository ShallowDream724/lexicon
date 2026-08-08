package server_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"path/filepath"
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
			ID      string `json:"id"`
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
	match := result.Items[0].Matches[0]
	if match.Scope != "sense" || match.EnglishText != "exact definition" || match.ChineseText != "精确释义" || match.Location.OwnerID != "sense-exact" {
		t.Fatalf("unexpected search evidence: %#v", match)
	}
	if got := searchIDs(t, get(t, service, "/api/v1/search?q=alpha&limit=3")); len(got) != 3 || got[0] != "exact" {
		t.Fatalf("English search changed: %#v", got)
	}
}

func TestChineseSearchIsEmptyWhenOptionalSidecarIsAbsent(t *testing.T) {
	service, _ := newFixtureService(t)
	response := get(t, service, "/api/v1/search?q=%E4%B8%AD%E6%96%87&limit=10")
	if response.Code != http.StatusOK || len(searchIDs(t, response)) != 0 {
		t.Fatalf("search without sidecar: %d %s", response.Code, response.Body.String())
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

func newFixtureServiceWithReverseSearch(t testing.TB) *server.Service {
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
			Location: reversesearch.Location{Section: reversesearch.SectionDefinitions, Part: "noun", OwnerID: "sense-exact", Path: []string{"senses", "0"}}, Weight: 100,
		},
		{
			DictionaryID: "fixture", EntryID: "one", Scope: reversesearch.ScopePhrase,
			Headword: "Alpha able", EnglishText: "useful phrase", ChineseText: "另一个释义",
			Location: reversesearch.Location{Section: reversesearch.SectionIdioms, OwnerID: "phrase-one", Path: []string{"idioms", "0"}}, Weight: 100,
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
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	t.Cleanup(func() {
		if err := service.Close(); err != nil {
			t.Error(err)
		}
	})
	return service
}
