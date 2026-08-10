package main

import (
	"database/sql"
	"os"
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

func TestOpenOptionalSemanticSearchReportsIncompleteConfiguredProvider(t *testing.T) {
	path := filepath.Join(t.TempDir(), "semantic.db")
	if err := os.WriteFile(path, []byte("present"), 0600); err != nil {
		t.Fatal(err)
	}
	engine, store, err := openOptionalSemanticSearch(semanticRuntimeConfig{path: path})
	if err == nil || engine != nil || store != nil {
		t.Fatalf("incomplete provider configuration should be diagnosed: engine=%v store=%v err=%v", engine, store, err)
	}
}

func TestDefaultConfigUsesThreeSecondSemanticRequestBudget(t *testing.T) {
	t.Setenv("DICTIONARY_SEMANTIC_TIMEOUT", "")
	t.Setenv("DICTIONARY_SEMANTIC_PERSISTENT_CACHE", "")
	t.Setenv("DICTIONARY_SEMANTIC_PERSISTENT_CACHE_MAX_ENTRIES", "")
	t.Setenv("DICTIONARY_SEMANTIC_PERSISTENT_CACHE_TTL", "")
	defaults := defaultConfig()
	if defaults.semanticTimeout != "3s" {
		t.Fatalf("semantic timeout default = %q", defaults.semanticTimeout)
	}
	if defaults.semanticPersistentCache != "true" || defaults.semanticPersistentCacheMaxEntries != "10000" || defaults.semanticPersistentCacheTTL != "720h" {
		t.Fatalf("unexpected persistent semantic cache defaults: %#v", defaults)
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
