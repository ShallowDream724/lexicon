package main

import (
	"database/sql"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

func TestOpenOptionalEtymologyAllowsMissingSidecar(t *testing.T) {
	store, err := openOptionalEtymology(filepath.Join(t.TempDir(), "missing.db"))
	if err != nil || store != nil {
		t.Fatalf("missing optional sidecar should be ignored: store=%v err=%v", store, err)
	}
}

func TestOpenOptionalSemanticSearchAllowsMissingSidecar(t *testing.T) {
	engine, store, err := openOptionalSemanticSearch(semanticRuntimeConfig{path: filepath.Join(t.TempDir(), "missing.db")})
	if err != nil || engine != nil || store != nil {
		t.Fatalf("missing optional semantic sidecar should be ignored: engine=%v store=%v err=%v", engine, store, err)
	}
}

func TestOpenOptionalSemanticSearchRejectsConfiguredInvalidSidecar(t *testing.T) {
	dir := t.TempDir()
	semanticPath := filepath.Join(dir, "semantic.db")
	reversePath := filepath.Join(dir, "reverse.db")
	for _, path := range []string{semanticPath, reversePath} {
		db, err := sql.Open("sqlite", path)
		if err != nil {
			t.Fatal(err)
		}
		if err := db.Ping(); err != nil {
			t.Fatal(err)
		}
		if err := db.Close(); err != nil {
			t.Fatal(err)
		}
	}
	engine, store, err := openOptionalSemanticSearch(semanticRuntimeConfig{
		path: semanticPath, dictionaryFingerprint: "primary", reverseSearchPath: reversePath,
		baseURL: "https://example.test", apiKey: "test-key", model: "test-model", modelKey: "test-model-key",
		timeout: "1s", cache: "1",
	})
	if err == nil || engine != nil || store != nil {
		t.Fatalf("configured invalid semantic sidecar should fail: engine=%v store=%v err=%v", engine, store, err)
	}
}
