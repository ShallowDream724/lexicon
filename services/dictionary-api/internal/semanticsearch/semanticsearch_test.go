package semanticsearch

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

const (
	primarySHA = "primary-sha"
	reverseSHA = "reverse-sha"
	projection = "semantic-projection-v1"
	modelKey   = "test-model-v1"
)

func TestOpenRejectsMismatchedAndCorruptSidecars(t *testing.T) {
	path := writeFixture(t)
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE metadata SET value = 'wrong' WHERE key = 'primary_sha256'`); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()
	if _, err := Open(path, primarySHA, reverseSHA, projection, modelKey); err == nil {
		t.Fatal("accepted mismatched metadata")
	}

	path = writeFixture(t)
	db, err = sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE vector_blocks SET data = x'7f' WHERE block_index = 0`); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()
	if _, err := Open(path, primarySHA, reverseSHA, projection, modelKey); err == nil {
		t.Fatal("accepted corrupt vector block")
	}
}

func TestStoreSearchScopeGroupingOrderAndPagination(t *testing.T) {
	store := openFixture(t)
	defer store.Close()
	senses, _ := NewScopeFilter(ScopeSense)
	page, err := store.Search(context.Background(), []float32{1, 0}, Options{Limit: 10, Scopes: senses})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Groups) != 2 || page.Groups[0].EntryID != "alpha" || page.Groups[1].EntryID != "beta" {
		t.Fatalf("unexpected scoped groups: %#v", page.Groups)
	}
	if len(page.Groups[0].Matches) != 3 {
		t.Fatalf("evidence limit ignored: %#v", page.Groups[0].Matches)
	}
	for run := 0; run < 5; run++ {
		got, err := store.Search(context.Background(), []float32{1, 0}, Options{Offset: 1, Limit: 1, Scopes: senses})
		if err != nil || len(got.Groups) != 1 || got.Groups[0].EntryID != "beta" || got.HasMore {
			t.Fatalf("unstable page %#v, %v", got, err)
		}
	}
	phrases, _ := NewScopeFilter(ScopePhrase)
	page, err = store.Search(context.Background(), []float32{1, 0}, Options{Limit: 10, Scopes: phrases})
	if err != nil || len(page.Groups) != 1 || page.Groups[0].EntryID != "alpha" || page.Groups[0].Matches[0].Scope != ScopePhrase {
		t.Fatalf("scope filter failed: %#v, %v", page, err)
	}
}

func TestStoreSearchHonorsCancellation(t *testing.T) {
	store := openFixture(t)
	defer store.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := store.Search(ctx, []float32{1, 0}, Options{Limit: 1, Scopes: AllScopeFilter()}); err == nil {
		t.Fatal("cancelled search succeeded")
	}
}

func TestOpenAIEmbedderRequestAndResponseValidation(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/embeddings" || r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer secret" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL)
		}
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
		}
		if payload["input"] != "query" || payload["model"] != "embedding-model" || payload["encoding_format"] != "float" {
			t.Errorf("unexpected payload %#v", payload)
		}
		_, _ = w.Write([]byte(`{"data":[{"index":0,"embedding":[3,4]}]}`))
	}))
	defer server.Close()
	embedder := newHTTPEmbedder(t, server.URL)
	vector, err := embedder.Embed(context.Background(), "query")
	if err != nil || len(vector) != 2 || vector[0] != .6 || vector[1] != .8 {
		t.Fatalf("unexpected vector %#v, %v", vector, err)
	}

	invalid := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"data":[{"index":0,"embedding":[0,0]}]}`))
	}))
	defer invalid.Close()
	embedder = newHTTPEmbedder(t, invalid.URL)
	if _, err := embedder.Embed(context.Background(), "query"); err == nil {
		t.Fatal("invalid provider response accepted")
	}
}

func TestEngineCoalescesEmbeddingAndCachesPages(t *testing.T) {
	store := openFixture(t)
	defer store.Close()
	started := make(chan struct{})
	release := make(chan struct{})
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if calls.Add(1) == 1 {
			close(started)
		}
		<-release
		_, _ = w.Write([]byte(`{"data":[{"index":0,"embedding":[1,0]}]}`))
	}))
	defer server.Close()
	engine, err := NewEngine(store, newHTTPEmbedder(t, server.URL), 4)
	if err != nil {
		t.Fatal(err)
	}
	options := Options{Limit: 1, Scopes: AllScopeFilter()}
	var wait sync.WaitGroup
	results := make(chan error, 2)
	for range 2 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, err := engine.Search(context.Background(), "Query", options)
			results <- err
		}()
	}
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("embedding request did not start")
	}
	close(release)
	wait.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatal(err)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("expected one provider call, got %d", calls.Load())
	}
	if _, err := engine.Search(context.Background(), " query ", options); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatalf("page cache missed: %d provider calls", calls.Load())
	}
}

func newHTTPEmbedder(t *testing.T, baseURL string) *OpenAIEmbedder {
	t.Helper()
	embedder, err := NewOpenAIEmbedder(OpenAIEmbedderConfig{BaseURL: baseURL, APIKey: "secret", Model: "embedding-model", ModelKey: modelKey, Dimensions: 2, Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	return embedder
}

func openFixture(t *testing.T) *Store {
	t.Helper()
	store, err := Open(writeFixture(t), primarySHA, reverseSHA, projection, modelKey)
	if err != nil {
		t.Fatal(err)
	}
	return store
}

func writeFixture(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "semantic.db")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	statements := []string{
		`CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
		`CREATE TABLE texts (id INTEGER PRIMARY KEY, chinese_text TEXT NOT NULL UNIQUE, scope_mask INTEGER NOT NULL)`,
		`CREATE TABLE vector_blocks (block_index INTEGER PRIMARY KEY, first_vector_id INTEGER NOT NULL, vector_count INTEGER NOT NULL, data BLOB NOT NULL)`,
		`CREATE TABLE documents (text_id INTEGER NOT NULL, entry_id TEXT NOT NULL, headword TEXT NOT NULL, scope TEXT NOT NULL, english_text TEXT NOT NULL, chinese_text TEXT NOT NULL, section TEXT NOT NULL, part TEXT NOT NULL, owner_id TEXT NOT NULL, path_json TEXT NOT NULL, weight INTEGER NOT NULL)`,
		`CREATE INDEX documents_text_id ON documents(text_id)`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	metadata := map[string]string{
		"schema_version": SchemaVersion, "primary_sha256": primarySHA, "reverse_search_sha256": reverseSHA, "projection_version": projection,
		"model_key": modelKey, "dimensions": "2", "normalization": "l2", "quantization": "symmetric-int8-127", "vector_count": "4", "block_size": "4",
	}
	for key, value := range metadata {
		if _, err := db.Exec(`INSERT INTO metadata(key, value) VALUES (?, ?)`, key, value); err != nil {
			t.Fatal(err)
		}
	}
	texts := []struct {
		id, mask int
		text     string
	}{{0, 1, "alpha sense"}, {1, 2, "alpha phrase"}, {2, 1, "beta sense"}, {3, 16, "gamma example"}}
	for _, text := range texts {
		if _, err := db.Exec(`INSERT INTO texts(id, chinese_text, scope_mask) VALUES (?, ?, ?)`, text.id, text.text, text.mask); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`INSERT INTO vector_blocks(block_index, first_vector_id, vector_count, data) VALUES (0, 0, 4, ?)`, []byte{127, 0, 110, 20, 0, 127, 129, 0}); err != nil {
		t.Fatal(err)
	}
	documents := []struct {
		textID          int
		entry, headword string
		scope           Scope
		weight          int
	}{
		{0, "alpha", "alpha", ScopeSense, 10}, {0, "alpha", "alpha", ScopeSense, 9}, {0, "alpha", "alpha", ScopeSense, 8}, {0, "alpha", "alpha", ScopeSense, 7},
		{1, "alpha", "alpha", ScopePhrase, 8}, {2, "beta", "beta", ScopeSense, 6}, {3, "gamma", "gamma", ScopeExample, 5},
	}
	for index, document := range documents {
		pathJSON, _ := json.Marshal([]string{"part", string(rune('a' + index))})
		if _, err := db.Exec(`INSERT INTO documents(text_id, entry_id, headword, scope, english_text, chinese_text, section, part, owner_id, path_json, weight) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, document.textID, document.entry, document.headword, document.scope, "english", "chinese", "definitions", "part", "owner", string(pathJSON), document.weight); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}
