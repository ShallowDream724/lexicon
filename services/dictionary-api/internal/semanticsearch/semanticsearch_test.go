package semanticsearch

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

const (
	primarySHA    = "primary-sha"
	reverseSHA    = "reverse-sha"
	projection    = ProjectionVersion
	modelKey      = "test-model-v1"
	queryTemplate = "Embed this dictionary query: {query}"
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

	path = writeFixture(t)
	db, err = sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE metadata SET value = '{query} and {query}' WHERE key = 'query_template'`); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()
	if _, err := Open(path, primarySHA, reverseSHA, projection, modelKey); err == nil {
		t.Fatal("accepted sidecar without a valid query template")
	}

	path = writeFixture(t)
	db, err = sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE documents SET semantic_role = 'unsupported' WHERE rowid = 1`); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()
	if _, err := Open(path, primarySHA, reverseSHA, projection, modelKey); err == nil {
		t.Fatal("accepted sidecar with invalid document semantic role")
	}

	for _, value := range []string{
		`{"model":"other-model"}`,
		`[]`,
		`{"note":"` + strings.Repeat("x", maxQueryExtraJSONB) + `"}`,
	} {
		path = writeFixture(t)
		db, err = sql.Open("sqlite", path)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`UPDATE metadata SET value = ? WHERE key = 'query_extra_json'`, value); err != nil {
			t.Fatal(err)
		}
		_ = db.Close()
		if _, err := Open(path, primarySHA, reverseSHA, projection, modelKey); err == nil {
			t.Fatalf("accepted invalid query extra JSON %q", value[:min(len(value), 32)])
		}
	}
}

func TestStoreSearchScopeGroupingOrderAndPagination(t *testing.T) {
	store := openFixture(t)
	defer store.Close()
	if store.QueryTemplate() != queryTemplate {
		t.Fatalf("unexpected query template %q", store.QueryTemplate())
	}
	extra := store.QueryExtraJSON()
	extra[0] = '['
	if string(store.QueryExtraJSON()) != "{}" {
		t.Fatal("query extra JSON getter exposed store-owned bytes")
	}
	senses, _ := NewScopeFilter(ScopeSense)
	page, err := store.Search(context.Background(), []float32{1, 0}, Options{Limit: 10, Scopes: senses})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Groups) != 2 || page.Groups[0].EntryID != "alpha" || page.Groups[1].EntryID != "beta" {
		t.Fatalf("unexpected scoped groups: %#v", page.Groups)
	}
	if len(page.Groups[0].Matches) != 4 {
		t.Fatalf("evidence limit ignored: %#v", page.Groups[0].Matches)
	}
	if page.Groups[0].Matches[0].SemanticRole != SemanticRoleDefinition {
		t.Fatalf("semantic role was not projected: %#v", page.Groups[0].Matches[0])
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

func TestStoreRejectsCandidatesBelowMetadataMinimumScore(t *testing.T) {
	path := writeFixture(t)
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE metadata SET value = '0.99' WHERE key = 'minimum_score'`); err != nil {
		t.Fatal(err)
	}
	_ = db.Close()
	store, err := Open(path, primarySHA, reverseSHA, projection, modelKey)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if store.MinimumScore() != .99 {
		t.Fatalf("minimum score = %v", store.MinimumScore())
	}
	scopes, _ := NewScopeFilter(ScopeSense)
	page, err := store.Search(context.Background(), []float32{0, -1}, Options{Limit: 8, Scopes: scopes})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Groups) != 0 {
		t.Fatalf("weak semantic candidates were returned: %#v", page.Groups)
	}
}

func TestGroupAndPaginateKeepsDirectEvidenceInsideTheSameScoreBand(t *testing.T) {
	candidates := make([]documentCandidate, 0, maxMatches+1)
	for index := 0; index < maxMatches; index++ {
		candidates = append(candidates, documentCandidate{
			documentID: int64(index + 1), textID: index, entryID: "entry", headword: "entry",
			scope: ScopeResource, semanticRole: SemanticRoleHeading, resourceCategory: "grammar", english: "heading",
			chinese: "标题", dot: 14_500,
		})
	}
	candidates = append(candidates, documentCandidate{
		documentID: 99, textID: 99, entryID: "entry", headword: "entry",
		scope: ScopeResource, semanticRole: SemanticRoleExpression, resourceCategory: "grammar", english: "usable phrase",
		chinese: "可用表达", dot: 14_490,
	})

	page := groupAndPaginate(candidates, 0, 1)
	if len(page.Groups) != 1 || len(page.Groups[0].Matches) != maxMatches {
		t.Fatalf("unexpected grouped evidence: %#v", page)
	}
	if page.Groups[0].Matches[0].SemanticRole != SemanticRoleExpression {
		t.Fatalf("same-band direct evidence was truncated behind display text: %#v", page.Groups[0].Matches)
	}
}

func TestGroupAndPaginateSeparatesEntryRelevanceFromEvidenceUsability(t *testing.T) {
	candidates := []documentCandidate{
		{documentID: 1, textID: 1, entryID: "guidance-entry", headword: "guidance-entry", scope: ScopeResource, semanticRole: SemanticRoleGuidance, resourceCategory: "grammar", english: "rule", chinese: "规则", dot: 14_500},
		{documentID: 2, textID: 2, entryID: "direct-entry", headword: "direct-entry", scope: ScopeResource, semanticRole: SemanticRoleExpression, resourceCategory: "grammar", english: "pattern", chinese: "表达", dot: 14_490},
		{documentID: 3, textID: 3, entryID: "mixed", headword: "mixed", scope: ScopeResource, semanticRole: SemanticRoleGuidance, resourceCategory: "grammar", english: "note", chinese: "说明", dot: 14_500},
		{documentID: 4, textID: 4, entryID: "mixed", headword: "mixed", scope: ScopeResource, semanticRole: SemanticRoleExpression, resourceCategory: "grammar", english: "usable", chinese: "可用表达", dot: 14_490},
	}

	page := groupAndPaginate(candidates, 0, 10)
	if len(page.Groups) != 3 || page.Groups[0].EntryID != "guidance-entry" {
		t.Fatalf("answer kind overrode semantic entry relevance: %#v", page.Groups)
	}
	var mixed Group
	for _, group := range page.Groups {
		if group.EntryID == "mixed" {
			mixed = group
		}
	}
	if len(mixed.Matches) != 2 || mixed.Matches[0].SemanticRole != SemanticRoleExpression {
		t.Fatalf("answerable expression did not lead same-band entry evidence: %#v", mixed)
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
		if r.URL.Path != "/v1/embeddings" || r.Method != http.MethodPost || r.Header.Get("Authorization") != "Bearer secret" || r.Header.Get("User-Agent") != "Lexicon-Dictionary-API/1" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL)
		}
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Error(err)
		}
		if payload["input"] != "Embed this dictionary query: query" || payload["model"] != "embedding-model" || payload["encoding_format"] != "float" || payload["dimensions"] != float64(2) || payload["input_type"] != "query" {
			t.Errorf("unexpected payload %#v", payload)
		}
		_, _ = w.Write([]byte(`{"data":[{"index":0,"embedding":[3,4]}]}`))
	}))
	defer server.Close()
	embedder := newHTTPEmbedder(t, server.URL)
	vector, err := embedder.Embed(context.Background(), "query", queryTemplate, []byte(`{"input_type":"query"}`))
	if err != nil || len(vector) != 2 || vector[0] != .6 || vector[1] != .8 {
		t.Fatalf("unexpected vector %#v, %v", vector, err)
	}

	invalid := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"data":[{"index":0,"embedding":[0,0]}]}`))
	}))
	defer invalid.Close()
	embedder = newHTTPEmbedder(t, invalid.URL)
	if _, err := embedder.Embed(context.Background(), "query", queryTemplate, []byte(`{}`)); err == nil {
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
	if _, err := engine.Search(context.Background(), " query ", Options{Offset: 1, Limit: 1, Scopes: AllScopeFilter()}); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatalf("query-vector cache missed: %d provider calls", calls.Load())
	}
	if _, err := engine.Search(context.Background(), "query", Options{Limit: 2, Scopes: DefaultScopeFilter()}); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatalf("scope-specific page triggered another embedding: %d provider calls", calls.Load())
	}
}

func TestEngineEmbeddingFlightSurvivesLeaderCancellation(t *testing.T) {
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
	engine, err := NewEngine(store, newHTTPEmbedder(t, server.URL), 0)
	if err != nil {
		t.Fatal(err)
	}
	options := Options{Limit: 1, Scopes: AllScopeFilter()}
	leaderCtx, cancelLeader := context.WithCancel(context.Background())
	leaderResult := make(chan error, 1)
	go func() {
		_, err := engine.Search(leaderCtx, "shared", options)
		leaderResult <- err
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("embedding request did not start")
	}
	cancelLeader()
	if err := <-leaderResult; !errors.Is(err, context.Canceled) {
		t.Fatalf("leader cancellation = %v", err)
	}
	waiterResult := make(chan error, 1)
	go func() {
		_, err := engine.Search(context.Background(), "shared", options)
		waiterResult <- err
	}()
	close(release)
	if err := <-waiterResult; err != nil {
		t.Fatalf("waiter inherited leader cancellation: %v", err)
	}
	if calls.Load() != 1 {
		t.Fatalf("leader cancellation triggered %d provider calls", calls.Load())
	}
}

func TestEngineBoundsUniqueEmbeddingFlightsAndProviderConcurrency(t *testing.T) {
	store := openFixture(t)
	defer store.Close()
	embedder := &gatedEmbedder{
		started: make(chan string, 2),
		release: make(chan struct{}),
	}
	engine, err := newEngineWithLimits(store, embedder, 0, 0, nil, 1, 2)
	if err != nil {
		t.Fatal(err)
	}
	defer engine.Close()
	options := Options{Limit: 1, Scopes: AllScopeFilter()}
	results := make(chan error, 2)
	for _, query := range []string{"first", "second"} {
		go func() {
			_, err := engine.Search(context.Background(), query, options)
			results <- err
		}()
	}
	select {
	case <-embedder.started:
	case <-time.After(time.Second):
		t.Fatal("first embedding request did not start")
	}
	deadline := time.Now().Add(time.Second)
	for {
		engine.mu.Lock()
		flights := len(engine.flights)
		engine.mu.Unlock()
		if flights == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("second embedding flight was not registered")
		}
		time.Sleep(time.Millisecond)
	}
	if _, err := engine.Search(context.Background(), "third", options); !errors.Is(err, errEmbeddingCapacity) {
		t.Fatalf("capacity error = %v", err)
	}
	close(embedder.release)
	for range 2 {
		if err := <-results; err != nil {
			t.Fatal(err)
		}
	}
	if embedder.maxActive.Load() != 1 || embedder.calls.Load() != 2 {
		t.Fatalf("provider concurrency=%d calls=%d", embedder.maxActive.Load(), embedder.calls.Load())
	}
}

func TestPersistentVectorCacheReusesVectorsAcrossEngineRestartWithoutQueries(t *testing.T) {
	store := openFixture(t)
	defer store.Close()
	cachePath := filepath.Join(t.TempDir(), "query-vectors.db")
	config := persistentCacheConfig(cachePath, modelKey, 10, time.Hour)
	cache, err := NewSQLitePersistentVectorCache(config)
	if err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls.Add(1)
		_, _ = w.Write([]byte(`{"data":[{"index":0,"embedding":[1,0]}]}`))
	}))
	defer server.Close()
	engine, err := NewEngineWithPersistentVectorCache(store, newHTTPEmbedder(t, server.URL), 0, 0, cache)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := engine.Search(context.Background(), "private query", Options{Limit: 1, Scopes: AllScopeFilter()}); err != nil {
		t.Fatal(err)
	}
	if err := engine.Close(); err != nil {
		t.Fatal(err)
	}
	cache, err = NewSQLitePersistentVectorCache(config)
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Close()
	engine, err = NewEngineWithPersistentVectorCache(store, newHTTPEmbedder(t, server.URL), 0, 0, cache)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := engine.Search(context.Background(), "private query", Options{Limit: 1, Scopes: AllScopeFilter()}); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatalf("expected a restart cache hit, got %d provider calls", calls.Load())
	}
	contents, err := os.ReadFile(cachePath)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(contents), "private query") {
		t.Fatal("persistent cache wrote a plaintext query")
	}
}

func TestPersistentVectorCacheNamespaceExpiryCapacityAndFailureDegrade(t *testing.T) {
	weak := persistentCacheConfig(filepath.Join(t.TempDir(), "weak.db"), modelKey, 2, time.Hour)
	weak.Key = []byte("weak")
	if _, err := NewSQLitePersistentVectorCache(weak); err == nil {
		t.Fatal("persistent cache accepted a weak HMAC key")
	}
	path := filepath.Join(t.TempDir(), "query-vectors.db")
	now := time.Unix(1_000, 0)
	config := persistentCacheConfig(path, modelKey, 2, time.Hour)
	config.Now = func() time.Time { return now }
	cache, err := NewSQLitePersistentVectorCache(config)
	if err != nil {
		t.Fatal(err)
	}
	defer cache.Close()
	cache.Put(context.Background(), "one", []float32{1, 0})
	if vector, ok := cache.GetQuantized(context.Background(), "one"); !ok || len(vector) != 2 || vector[0] != 127 || vector[1] != 0 {
		t.Fatalf("persistent cache did not preserve scan quantization: %#v, %v", vector, ok)
	}
	var bytes int
	if err := cache.db.QueryRow(`SELECT length(vector) FROM query_vectors`).Scan(&bytes); err != nil || bytes != 2 {
		t.Fatalf("persistent cache payload size = %d, %v", bytes, err)
	}
	now = now.Add(time.Minute)
	cache.Put(context.Background(), "two", []float32{0, 1})
	now = now.Add(time.Minute)
	if _, ok := cache.Get(context.Background(), "one"); !ok {
		t.Fatal("expected initial cache entry")
	}
	now = now.Add(time.Minute)
	cache.Put(context.Background(), "three", []float32{.6, .8})
	if _, ok := cache.Get(context.Background(), "two"); ok {
		t.Fatal("least recently used entry was not evicted")
	}
	other := persistentCacheConfig(path, "other-model", 2, time.Hour)
	other.Now = func() time.Time { return now }
	otherCache, err := NewSQLitePersistentVectorCache(other)
	if err != nil {
		t.Fatal(err)
	}
	defer otherCache.Close()
	if _, ok := otherCache.Get(context.Background(), "one"); ok {
		t.Fatal("cache namespace leaked vectors across model keys")
	}
	now = now.Add(2 * time.Hour)
	if _, ok := cache.Get(context.Background(), "one"); ok {
		t.Fatal("expired cache entry was returned")
	}
	if err := cache.Close(); err != nil {
		t.Fatal(err)
	}
	store := openFixture(t)
	defer store.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"data":[{"index":0,"embedding":[1,0]}]}`))
	}))
	defer server.Close()
	engine, err := NewEngineWithPersistentVectorCache(store, newHTTPEmbedder(t, server.URL), 0, 0, cache)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := engine.Search(context.Background(), "cache failure", Options{Limit: 1, Scopes: AllScopeFilter()}); err != nil {
		t.Fatalf("cache failure disabled semantic search: %v", err)
	}
}

func TestOpenAIEmbedderDefaultsToThreeSecondRequestBudget(t *testing.T) {
	embedder, err := NewOpenAIEmbedder(OpenAIEmbedderConfig{BaseURL: "https://example.test", APIKey: "key", Model: "model", ModelKey: modelKey, Dimensions: 2})
	if err != nil {
		t.Fatal(err)
	}
	if embedder.timeout != 3*time.Second {
		t.Fatalf("default timeout = %s", embedder.timeout)
	}
}

func TestCandidatePoolCoversMaximumGroupWindow(t *testing.T) {
	got, err := candidatePoolLimit(0, 512)
	if err != nil || got != maximumCandidatePool || got < 4096 {
		t.Fatalf("maximum page candidate pool = %d, %v", got, err)
	}
	got, err = candidatePoolLimit(511, 1)
	if err != nil || got != maximumCandidatePool {
		t.Fatalf("last page candidate pool = %d, %v", got, err)
	}
}

type gatedEmbedder struct {
	started   chan string
	release   chan struct{}
	calls     atomic.Int32
	active    atomic.Int32
	maxActive atomic.Int32
}

func (embedder *gatedEmbedder) Embed(ctx context.Context, query, _ string, _ []byte) ([]float32, error) {
	embedder.calls.Add(1)
	active := embedder.active.Add(1)
	defer embedder.active.Add(-1)
	for {
		maximum := embedder.maxActive.Load()
		if active <= maximum || embedder.maxActive.CompareAndSwap(maximum, active) {
			break
		}
	}
	embedder.started <- query
	select {
	case <-embedder.release:
		return []float32{1, 0}, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (*gatedEmbedder) ModelKey() string { return modelKey }
func (*gatedEmbedder) Dimensions() int  { return 2 }

func newHTTPEmbedder(t *testing.T, baseURL string) *OpenAIEmbedder {
	t.Helper()
	embedder, err := NewOpenAIEmbedder(OpenAIEmbedderConfig{BaseURL: baseURL, APIKey: "secret", Model: "embedding-model", ModelKey: modelKey, Dimensions: 2, Timeout: time.Second})
	if err != nil {
		t.Fatal(err)
	}
	return embedder
}

func persistentCacheConfig(path, keyModel string, maxEntries int, ttl time.Duration) PersistentVectorCacheConfig {
	return PersistentVectorCacheConfig{
		Path: path, Key: []byte(strings.Repeat("k", 32)), ModelKey: keyModel, Dimensions: 2,
		QueryTemplate: queryTemplate, QueryExtraJSON: []byte(`{}`), MaxEntries: maxEntries, TTL: ttl,
	}
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
		`CREATE TABLE texts (id INTEGER PRIMARY KEY, normalized_chinese_text TEXT NOT NULL UNIQUE, scope_mask INTEGER NOT NULL)`,
		`CREATE TABLE vector_blocks (block_index INTEGER PRIMARY KEY, first_vector_id INTEGER NOT NULL, vector_count INTEGER NOT NULL, data BLOB NOT NULL)`,
		`CREATE TABLE documents (text_id INTEGER NOT NULL, entry_id TEXT NOT NULL, headword TEXT NOT NULL, scope TEXT NOT NULL, semantic_role TEXT NOT NULL, resource_category TEXT NOT NULL, english_text TEXT NOT NULL, chinese_text TEXT NOT NULL, candidate_text TEXT NOT NULL, definition_text TEXT NOT NULL, section TEXT NOT NULL, part TEXT NOT NULL, owner_id TEXT NOT NULL, path_json TEXT NOT NULL, weight INTEGER NOT NULL)`,
		`CREATE INDEX documents_text_id ON documents(text_id)`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	metadata := map[string]string{
		"schema_version": SchemaVersion, "primary_sha256": primarySHA, "reverse_search_sha256": reverseSHA, "projection_version": projection,
		"model_key": modelKey, "query_template": queryTemplate, "query_extra_json": "{}", "minimum_score": "-1", "dimensions": "2", "normalization": "l2", "quantization": "symmetric-int8-127", "vector_count": "4", "block_size": "4",
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
		if _, err := db.Exec(`INSERT INTO texts(id, normalized_chinese_text, scope_mask) VALUES (?, ?, ?)`, text.id, text.text, text.mask); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`INSERT INTO vector_blocks(block_index, first_vector_id, vector_count, data) VALUES (0, 0, 4, ?)`, []byte{127, 0, 110, 20, 0, 127, 129, 0}); err != nil {
		t.Fatal(err)
	}
	documents := []struct {
		textID           int
		entry, headword  string
		scope            Scope
		semanticRole     SemanticRole
		resourceCategory ResourceCategory
		weight           int
	}{
		{0, "alpha", "alpha", ScopeSense, SemanticRoleDefinition, "", 10}, {0, "alpha", "alpha", ScopeSense, SemanticRoleDefinition, "", 9}, {0, "alpha", "alpha", ScopeSense, SemanticRoleDefinition, "", 8}, {0, "alpha", "alpha", ScopeSense, SemanticRoleDefinition, "", 7},
		{1, "alpha", "alpha", ScopePhrase, SemanticRoleDefinition, "", 8}, {2, "beta", "beta", ScopeSense, SemanticRoleDefinition, "", 6}, {3, "gamma", "gamma", ScopeExample, SemanticRoleContext, "", 5},
	}
	for index, document := range documents {
		pathJSON, _ := json.Marshal([]string{"part", string(rune('a' + index))})
		if _, err := db.Exec(`INSERT INTO documents(text_id, entry_id, headword, scope, semantic_role, resource_category, english_text, chinese_text, candidate_text, definition_text, section, part, owner_id, path_json, weight) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, document.textID, document.entry, document.headword, document.scope, document.semanticRole, document.resourceCategory, "english", "chinese", "candidate", "definition", "definitions", "part", "owner", string(pathJSON), document.weight); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}
