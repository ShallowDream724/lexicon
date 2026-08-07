package server_test

import (
	"archive/zip"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	"dictionary-api/internal/audio"
	"dictionary-api/internal/etymology"
	"dictionary-api/internal/importer"
	"dictionary-api/internal/payload"
	"dictionary-api/internal/schema"
	"dictionary-api/internal/server"
	_ "modernc.org/sqlite"
)

func TestImportRuntimeAPIAndNoLegacyLayout(t *testing.T) {
	svc, runtimePath := newFixtureService(t)
	response := get(t, svc, "/api/v1/search?q=alpha&limit=3")
	if response.Code != http.StatusOK {
		t.Fatalf("search: %d %s", response.Code, response.Body.String())
	}
	var search struct {
		Items []struct {
			ID                 string   `json:"id"`
			PartsOfSpeech      []string `json:"partsOfSpeech"`
			TranslationPreview string   `json:"translationPreview"`
		} `json:"items"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &search); err != nil {
		t.Fatal(err)
	}
	if len(search.Items) != 3 || search.Items[0].ID != "exact" || search.Items[1].ID != "one" || search.Items[2].ID != "two" {
		t.Fatalf("unexpected ranking: %#v", search.Items)
	}
	if got := search.Items[0]; !reflect.DeepEqual(got.PartsOfSpeech, []string{"noun", "verb"}) || got.TranslationPreview != "字典释义" {
		t.Fatalf("unexpected search projection: %#v", got)
	}

	entry := get(t, svc, "/api/v1/entries/exact")
	if entry.Code != http.StatusOK || entry.Header().Get("Content-Type") != "application/json; charset=utf-8" {
		t.Fatalf("entry: %d %s", entry.Code, entry.Header())
	}
	var payload struct {
		Headword      string          `json:"headword"`
		SourceVersion string          `json:"sourceVersion"`
		Body          json.RawMessage `json:"body"`
	}
	if err := json.Unmarshal(entry.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Headword != "alpha" || payload.SourceVersion != "fixture-v1" || !strings.Contains(string(payload.Body), `"unknown":{"order":[2,1]}`) {
		t.Fatalf("bad entry: %#v body=%s", payload, payload.Body)
	}

	db, err := sql.Open("sqlite", "file:"+runtimePath+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var legacyTableCount int
	if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'oxford_x_word'`).Scan(&legacyTableCount); err != nil {
		t.Fatal(err)
	}
	if legacyTableCount != 0 {
		t.Fatal("runtime database retained legacy source table")
	}
	var payloadType string
	if err := db.QueryRow(`SELECT type FROM pragma_table_info('entries') WHERE name = 'payload'`).Scan(&payloadType); err != nil {
		t.Fatal(err)
	}
	if payloadType != "BLOB" {
		t.Fatalf("payload column is %q, want BLOB", payloadType)
	}
	var checksumType string
	if err := db.QueryRow(`SELECT type FROM pragma_table_info('entries') WHERE name = 'payload_sha256'`).Scan(&checksumType); err != nil {
		t.Fatal(err)
	}
	if checksumType != "BLOB" {
		t.Fatalf("payload checksum column is %q, want BLOB", checksumType)
	}
	var redundantIndexes int
	if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND tbl_name = 'entry_terms' AND sql IS NOT NULL`).Scan(&redundantIndexes); err != nil {
		t.Fatal(err)
	}
	if redundantIndexes != 0 {
		t.Fatalf("entry_terms has %d redundant secondary indexes", redundantIndexes)
	}
}

func TestImportProducesDeterministicDictionaryAndPayloads(t *testing.T) {
	dir := t.TempDir()
	sourcePath := filepath.Join(dir, "source.db")
	createSource(t, sourcePath)
	firstPath := filepath.Join(dir, "first.db")
	secondPath := filepath.Join(dir, "second.db")
	for _, target := range []string{firstPath, secondPath} {
		if err := importer.Import(context.Background(), importer.Config{SourcePath: sourcePath, TargetPath: target, SourceVersion: "fixture-v1"}); err != nil {
			t.Fatal(err)
		}
	}

	readArtifacts := func(path string) ([]byte, []byte) {
		db, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
		if err != nil {
			t.Fatal(err)
		}
		defer db.Close()
		var dictionary, payloadBytes []byte
		if err := db.QueryRow(`SELECT blob_value FROM dictionary_metadata WHERE key = 'payload_dictionary'`).Scan(&dictionary); err != nil {
			t.Fatal(err)
		}
		if err := db.QueryRow(`SELECT payload FROM entries WHERE id = 'exact'`).Scan(&payloadBytes); err != nil {
			t.Fatal(err)
		}
		return dictionary, payloadBytes
	}

	firstDictionary, firstPayload := readArtifacts(firstPath)
	secondDictionary, secondPayload := readArtifacts(secondPath)
	if !bytes.Equal(firstDictionary, secondDictionary) || !bytes.Equal(firstPayload, secondPayload) {
		t.Fatal("identical imports produced different codec artifacts")
	}
	firstDatabase, err := os.ReadFile(firstPath)
	if err != nil {
		t.Fatal(err)
	}
	secondDatabase, err := os.ReadFile(secondPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(firstDatabase, secondDatabase) {
		t.Fatal("identical imports produced different runtime database files")
	}
}

func TestImportAppliesStorageOptionsAndRecordsThem(t *testing.T) {
	dir := t.TempDir()
	sourcePath := filepath.Join(dir, "source.db")
	createSource(t, sourcePath)
	runtimePath := filepath.Join(dir, "runtime.db")
	storage := importer.StorageOptions{PageSize: 8 * 1024, CompressionLevel: 7, DictionarySize: 64 * 1024}
	if err := importer.Import(context.Background(), importer.Config{SourcePath: sourcePath, TargetPath: runtimePath, SourceVersion: "fixture-v1", Storage: storage}); err != nil {
		t.Fatal(err)
	}

	db, err := sql.Open("sqlite", "file:"+runtimePath+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var pageSize int
	if err := db.QueryRow(`PRAGMA page_size`).Scan(&pageSize); err != nil {
		t.Fatal(err)
	}
	if pageSize != storage.PageSize {
		t.Fatalf("page size = %d, want %d", pageSize, storage.PageSize)
	}
	for key, want := range map[string]string{"payload_compression_level": "7", "payload_dictionary_size": "65536"} {
		var got string
		if err := db.QueryRow(`SELECT value FROM dictionary_metadata WHERE key = ?`, key).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Fatalf("metadata %s = %q, want %q", key, got, want)
		}
	}
	codecName, dictionary, err := schema.PayloadSettings(db)
	if err != nil {
		t.Fatal(err)
	}
	codec, known, err := payload.ByName(codecName, dictionary)
	if err != nil || !known {
		t.Fatalf("payload codec: known=%t err=%v", known, err)
	}
	var compressed []byte
	var rawSize int64
	if err := db.QueryRow(`SELECT payload, payload_size FROM entries WHERE id = 'exact'`).Scan(&compressed, &rawSize); err != nil {
		t.Fatal(err)
	}
	raw, err := codec.Decompress(compressed, rawSize)
	if err != nil || !json.Valid(raw) {
		t.Fatalf("custom storage payload is unreadable: %v", err)
	}
}

func TestSearchRejectsMalformedBoundsAndIsStable(t *testing.T) {
	svc, _ := newFixtureService(t)
	first := get(t, svc, "/api/v1/search?q=alpha&limit=3")
	second := get(t, svc, "/api/v1/search?q=alpha&limit=3")
	if first.Code != http.StatusOK || first.Body.String() != second.Body.String() {
		t.Fatalf("unstable responses: %d %s", first.Code, first.Body.String())
	}
	for _, target := range []string{"/api/v1/search", "/api/v1/search?q=alpha&limit=0", "/api/v1/search?q=alpha&limit=51", "/api/v1/search?q=alpha&limit=nope"} {
		if recorder := get(t, svc, target); recorder.Code != http.StatusBadRequest {
			t.Errorf("%s: got %d", target, recorder.Code)
		}
	}
	if recorder := get(t, svc, "/api/v1/entries/missing"); recorder.Code != http.StatusNotFound {
		t.Fatalf("missing entry: %d", recorder.Code)
	}
}

func TestSearchCorrectsBoundedOneEditTypos(t *testing.T) {
	svc, _ := newFixtureService(t)
	for _, test := range []struct {
		query string
		want  []string
	}{
		{query: "graeteful", want: []string{"grateful"}},
		{query: "grateul", want: []string{"grateful"}},
		{query: "gratefel", want: []string{"grateful", "gratefyl"}},
	} {
		t.Run(test.query, func(t *testing.T) {
			response := get(t, svc, "/api/v1/search?q="+url.QueryEscape(test.query))
			if response.Code != http.StatusOK {
				t.Fatalf("search: %d %s", response.Code, response.Body.String())
			}
			if got := searchIDs(t, response); !reflect.DeepEqual(got, test.want) {
				t.Fatalf("items = %v, want %v", got, test.want)
			}
		})
	}

	limited := get(t, svc, "/api/v1/search?q=gratefql&limit=1")
	if limited.Code != http.StatusOK {
		t.Fatalf("limited typo search: %d %s", limited.Code, limited.Body.String())
	}
	if got := searchIDs(t, limited); !reflect.DeepEqual(got, []string{"grateful"}) {
		t.Fatalf("limited typo items = %v, want [grateful]", got)
	}
}

func TestSearchKeepsExactAndPrefixPathsAndSkipsIneligibleTypoQueries(t *testing.T) {
	svc, _ := newFixtureService(t)
	for _, test := range []struct {
		query string
		want  []string
	}{
		{query: "grateful", want: []string{"grateful"}},
		{query: "grat", want: []string{"grateful", "gratefyl", "gratitude"}},
		{query: "zz", want: []string{}},
		{query: "grate ful", want: []string{}},
		{query: strings.Repeat("a", 65), want: []string{}},
	} {
		t.Run(test.query, func(t *testing.T) {
			response := get(t, svc, "/api/v1/search?q="+url.QueryEscape(test.query))
			if response.Code != http.StatusOK {
				t.Fatalf("search: %d %s", response.Code, response.Body.String())
			}
			if got := searchIDs(t, response); !reflect.DeepEqual(got, test.want) {
				t.Fatalf("items = %v, want %v", got, test.want)
			}
		})
	}

	first := get(t, svc, "/api/v1/search?q=missing")
	second := get(t, svc, "/api/v1/search?q=missing")
	if first.Code != http.StatusOK || second.Code != http.StatusOK || first.Body.String() != second.Body.String() {
		t.Fatalf("empty typo responses are unstable: first=%d %s second=%d %s", first.Code, first.Body.String(), second.Code, second.Body.String())
	}
}

func TestAudioLookupStreamsIndexedFileAndRejectsTraversal(t *testing.T) {
	svc, _ := newFixtureService(t)
	response := get(t, svc, "/api/v1/media/headword-audio?key=alpha%23_gb_1")
	if response.Code != http.StatusOK || response.Header().Get("Content-Type") != "audio/mpeg" || response.Body.String() != "fixture-mp3" {
		t.Fatalf("audio: %d %s %q", response.Code, response.Header(), response.Body.String())
	}
	if response := get(t, svc, "/api/v1/media/headword-audio?key=../alpha%23_gb_1"); response.Code != http.StatusNotFound {
		t.Fatalf("traversal: %d", response.Code)
	}
}

func TestEtymologyEndpointsEntryEnhancementsAndMergedSearch(t *testing.T) {
	svc := newFixtureServiceWithEtymology(t)

	term := get(t, svc, "/api/v1/enhancements/etymology/terms/Alpha")
	if term.Code != http.StatusOK {
		t.Fatalf("term summary: %d %s", term.Code, term.Body.String())
	}
	var summary struct {
		SchemaVersion string `json:"schemaVersion"`
		Kind          string `json:"kind"`
		ResourceID    string `json:"resourceId"`
		Articles      []struct {
			ID string `json:"id"`
		} `json:"articles"`
	}
	if err := json.Unmarshal(term.Body.Bytes(), &summary); err != nil {
		t.Fatal(err)
	}
	if summary.SchemaVersion != "1.0" || summary.Kind != "etymology" || summary.ResourceID != "etymology:alpha" || len(summary.Articles) != 1 || summary.Articles[0].ID != "501" {
		t.Fatalf("unexpected term summary: %#v", summary)
	}

	article := get(t, svc, "/api/v1/enhancements/etymology/articles/501")
	if article.Code != http.StatusOK || !strings.Contains(article.Body.String(), `"document":{"blocks"`) {
		t.Fatalf("article: %d %s", article.Code, article.Body.String())
	}

	entry := get(t, svc, "/api/v1/entries/exact")
	if entry.Code != http.StatusOK {
		t.Fatalf("entry: %d %s", entry.Code, entry.Body.String())
	}
	var entryBody struct {
		Enhancements []struct {
			Kind string `json:"kind"`
		} `json:"enhancements"`
	}
	if err := json.Unmarshal(entry.Body.Bytes(), &entryBody); err != nil {
		t.Fatal(err)
	}
	if len(entryBody.Enhancements) != 1 || entryBody.Enhancements[0].Kind != "etymology" || strings.Contains(entry.Body.String(), `"document"`) {
		t.Fatalf("entry enhancement projection: %s", entry.Body.String())
	}
	for _, test := range []struct {
		entryID, resourceID string
	}{
		{"terribly", "etymology:terribly"},
		{"adams", "etymology:adam's apple"},
	} {
		response := get(t, svc, "/api/v1/entries/"+test.entryID)
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"resourceId":"`+test.resourceID+`"`) {
			t.Fatalf("normalized enhancement %s: %d %s", test.entryID, response.Code, response.Body.String())
		}
	}

	alpha := get(t, svc, "/api/v1/search?q=alpha&limit=50")
	if alpha.Code != http.StatusOK {
		t.Fatalf("merged alpha search: %d %s", alpha.Code, alpha.Body.String())
	}
	for _, item := range searchItemsWithKinds(t, alpha) {
		if item.Kind == "etymology" && item.ID == "alpha" {
			t.Fatalf("duplicate etymology result survived dictionary match: %#v", item)
		}
		if item.Kind != "dictionary" && item.Kind != "etymology" {
			t.Fatalf("search item has no recognized kind: %#v", item)
		}
	}

	only := get(t, svc, "/api/v1/search?q=etymo&limit=10")
	if only.Code != http.StatusOK {
		t.Fatalf("sidecar-only search: %d %s", only.Code, only.Body.String())
	}
	items := searchItemsWithKinds(t, only)
	if len(items) != 1 || items[0].ID != "etymo-only" || items[0].Kind != "etymology" {
		t.Fatalf("sidecar-only result: %#v", items)
	}

	for _, query := range []string{"adam%27s%20apple", "adam%E2%80%99s%20apple"} {
		response := get(t, svc, "/api/v1/search?q="+query+"&limit=10")
		items := searchItemsWithKinds(t, response)
		if response.Code != http.StatusOK || len(items) != 1 || items[0].ID != "adams" || items[0].Kind != "dictionary" {
			t.Fatalf("apostrophe-compatible search %q: %d %#v", query, response.Code, items)
		}
	}
}

func TestEtymologyIsOptional(t *testing.T) {
	svc, _ := newFixtureService(t)
	if response := get(t, svc, "/api/v1/enhancements/etymology/terms/alpha"); response.Code != http.StatusNotFound {
		t.Fatalf("optional term endpoint = %d", response.Code)
	}
	entry := get(t, svc, "/api/v1/entries/exact")
	if entry.Code != http.StatusOK || !strings.Contains(entry.Body.String(), `"enhancements":[]`) {
		t.Fatalf("optional entry response: %d %s", entry.Code, entry.Body.String())
	}
}

func newFixtureService(t testing.TB) (*server.Service, string) {
	t.Helper()
	dir := t.TempDir()
	sourcePath := filepath.Join(dir, "source.db")
	createSource(t, sourcePath)
	runtimePath := filepath.Join(dir, "runtime.db")
	if err := importer.Import(context.Background(), importer.Config{SourcePath: sourcePath, TargetPath: runtimePath, SourceVersion: "fixture-v1"}); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", "file:"+runtimePath+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	if err := schema.Validate(db); err != nil {
		t.Fatal(err)
	}
	codecName, dictionary, err := schema.PayloadSettings(db)
	if err != nil {
		t.Fatal(err)
	}
	codec, known, err := payload.ByName(codecName, dictionary)
	if err != nil || !known {
		t.Fatalf("payload codec: %v", err)
	}
	zipPath := filepath.Join(dir, "audio.zip")
	createAudioZip(t, zipPath)
	index, err := audio.Open(zipPath)
	if err != nil {
		t.Fatal(err)
	}
	svc := server.New(db, index, server.Config{SourceVersion: "fixture-v1", PayloadCodec: codec, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	t.Cleanup(func() {
		if err := svc.Close(); err != nil {
			t.Error(err)
		}
	})
	return svc, runtimePath
}

func newFixtureServiceWithEtymology(t testing.TB) *server.Service {
	t.Helper()
	directory := t.TempDir()
	sourcePath := filepath.Join(directory, "source.db")
	createSource(t, sourcePath)
	runtimePath := filepath.Join(directory, "runtime.db")
	if err := importer.Import(context.Background(), importer.Config{SourcePath: sourcePath, TargetPath: runtimePath, SourceVersion: "fixture-v1"}); err != nil {
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
	etymologySourcePath := filepath.Join(directory, "etymology-source.db")
	createEtymologySource(t, etymologySourcePath)
	etymologyPath := filepath.Join(directory, "etymology.db")
	if err := etymology.Import(context.Background(), etymology.ImportConfig{SourcePath: etymologySourcePath, TargetPath: etymologyPath, SourceVersion: "fixture-etymology-v1"}); err != nil {
		t.Fatal(err)
	}
	etymologyStore, err := etymology.Open(etymologyPath)
	if err != nil {
		t.Fatal(err)
	}
	service := server.New(db, nil, server.Config{SourceVersion: "fixture-v1", PayloadCodec: codec, Etymology: etymologyStore, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	t.Cleanup(func() {
		if err := service.Close(); err != nil {
			t.Error(err)
		}
	})
	return service
}

func createEtymologySource(t testing.TB, path string) {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`
		CREATE TABLE word_index_etymapp (id INTEGER PRIMARY KEY, word TEXT, lowercase TEXT, word_ids TEXT, summary TEXT, related_words TEXT);
		CREATE TABLE vocabulary_etymapp (id INTEGER PRIMARY KEY, word TEXT, type TEXT, sort INTEGER, etymology TEXT, property TEXT, graph_key TEXT);
			INSERT INTO word_index_etymapp (id, word, lowercase, word_ids, summary, related_words) VALUES (1, 'Alpha', 'alpha', '[501]', '', '');
			INSERT INTO word_index_etymapp (id, word, lowercase, word_ids, summary, related_words) VALUES (2, 'Etymo Only', 'etymo-only', '[502]', '', '');
			INSERT INTO word_index_etymapp (id, word, lowercase, word_ids, summary, related_words) VALUES (3, 'terribly', 'terribly', '[503]', '', '');
			INSERT INTO word_index_etymapp (id, word, lowercase, word_ids, summary, related_words) VALUES (4, 'Adam''s apple', 'adam''s apple', '[504]', '', '');
			INSERT INTO vocabulary_etymapp (id, word, type, sort, etymology, property, graph_key) VALUES (501, 'Alpha', 'entry', 1, '<p>Alpha origin</p>', '(origin)', '');
			INSERT INTO vocabulary_etymapp (id, word, type, sort, etymology, property, graph_key) VALUES (502, 'Etymo Only', 'entry', 1, '<p>Independent origin</p>', '(origin)', '');
			INSERT INTO vocabulary_etymapp (id, word, type, sort, etymology, property, graph_key) VALUES (503, 'terribly', 'entry', 1, '<p>Terribly origin</p>', '(adv.)', '');
			INSERT INTO vocabulary_etymapp (id, word, type, sort, etymology, property, graph_key) VALUES (504, 'Adam''s apple', 'entry', 1, '<p>Adam''s apple origin</p>', '(n.)', '');
	`); err != nil {
		t.Fatal(err)
	}
}

func createSource(t testing.TB, path string) {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE oxford_x_word (id TEXT PRIMARY KEY, word TEXT, word_body TEXT, word_search TEXT, internal_only TEXT)`); err != nil {
		t.Fatal(err)
	}
	for _, row := range []struct{ id, word, search, body string }{
		{"two", "alpha zoo", "alpha zoo", fixtureBody("two")},
		{"exact", "alpha", "alpha", fixtureBody("exact")},
		{"one", "Alpha able", "alpha able", fixtureBody("one")},
		{"grateful", "grateful", "grateful", fixtureBody("grateful")},
		{"gratefyl", "gratefyl", "gratefyl", fixtureBody("gratefyl")},
		{"gratitude", "gratitude", "gratitude", fixtureBody("gratitude")},
		{"terribly", "ter·ribly", "ter·ribly", fixtureBody("terribly")},
		{"adams", "Adam’s apple", "Adam’s apple", fixtureBody("adams")},
		{"the", "the", "the", fixtureBody("the")},
		{"long-a", strings.Repeat("a", 64), strings.Repeat("a", 64), fixtureBody("long-a")},
	} {
		if _, err := db.Exec(`INSERT INTO oxford_x_word (id, word, word_search, word_body, internal_only) VALUES (?, ?, ?, ?, 'omit')`, row.id, row.word, row.search, row.body); err != nil {
			t.Fatal(err)
		}
	}
}

func fixtureBody(label string) string {
	return `{"unknown":{"order":[2,1]},"label":"` + label + `","pos":[{"value":"noun"},{"value":"verb"},{"value":"noun"}],"sn_g":[{"def_simp":[{"tag":"simp","value":"字典释义"}]}],"padding":"` + strings.Repeat("deterministic dictionary training sample ", 1200) + `"}`
}

func createAudioZip(t testing.TB, path string) {
	t.Helper()
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(file)
	member, err := writer.Create("audio/alpha#_gb_1.mp3")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := member.Write([]byte("fixture-mp3")); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
}

func get(t *testing.T, service *server.Service, target string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, target, nil)
	recorder := httptest.NewRecorder()
	service.Handler().ServeHTTP(recorder, request)
	return recorder
}

func searchIDs(t testing.TB, response *httptest.ResponseRecorder) []string {
	t.Helper()
	var body struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	ids := make([]string, 0, len(body.Items))
	for _, item := range body.Items {
		ids = append(ids, item.ID)
	}
	return ids
}

func searchItemsWithKinds(t testing.TB, response *httptest.ResponseRecorder) []struct{ ID, Kind string } {
	t.Helper()
	var body struct {
		Items []struct {
			ID   string `json:"id"`
			Kind string `json:"kind"`
		} `json:"items"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	items := make([]struct{ ID, Kind string }, 0, len(body.Items))
	for _, item := range body.Items {
		items = append(items, struct{ ID, Kind string }{ID: item.ID, Kind: item.Kind})
	}
	return items
}

func BenchmarkRandomEntryDecode(b *testing.B) {
	svc, _ := newFixtureService(b)
	ids := []string{"exact", "one", "two"}
	var sequence uint64
	b.ResetTimer()
	b.RunParallel(func(worker *testing.PB) {
		for worker.Next() {
			id := ids[atomic.AddUint64(&sequence, 1)%uint64(len(ids))]
			request := httptest.NewRequest(http.MethodGet, "/api/v1/entries/"+id, nil)
			recorder := httptest.NewRecorder()
			svc.Handler().ServeHTTP(recorder, request)
			if recorder.Code != http.StatusOK {
				b.Fatalf("unexpected entry response: %d", recorder.Code)
			}
		}
	})
}
