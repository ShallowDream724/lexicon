package reversesearch

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

func TestImportOpenAndSearch(t *testing.T) {
	root := t.TempDir()
	dictionary := filepath.Join(root, "dictionary.db")
	if err := os.WriteFile(dictionary, []byte("primary-v1"), 0600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "reverse.db")
	documents := []SearchDocument{
		doc("1", ScopeSense, "silicon", "硅是一种化学元素"),
		doc("1", ScopeExample, "silicon", "这块硅片用于测试"),
		doc("1", ScopeUsage, "silicon", "硅常用于半导体材料"),
		doc("2", ScopePhrase, "silicon valley", "硅谷是科技产业中心"),
		doc("3", ScopeSense, "computer", "计算机是一种电子设备"),
	}
	importSidecar(t, dictionary, target, documents, false)
	store, err := Open(target, digest(t, dictionary))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	groups, err := store.Search(context.Background(), "矽是一种化学元素", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(groups) == 0 || groups[0].EntryID != "1" || groups[0].Matches[0].Scope != ScopeSense {
		t.Fatalf("unexpected exact search %#v", groups)
	}
	if len(groups[0].Matches) > maxMatches {
		t.Fatalf("match limit ignored: %#v", groups[0])
	}
	if got, err := store.Search(context.Background(), "科技产业", 10); err != nil || len(got) != 1 || got[0].EntryID != "2" {
		t.Fatalf("phrase search got %#v, %v", got, err)
	}
	if got, err := store.Search(context.Background(), "abc", 10); err != nil || len(got) != 0 {
		t.Fatalf("non-CJK search got %#v, %v", got, err)
	}
	if got, err := store.Search(context.Background(), "硅", 10); err != nil || len(got) == 0 || got[0].Matches[0].Scope == ScopeExample {
		t.Fatalf("single rune search got %#v, %v", got, err)
	}
	if got, err := store.Search(context.Background(), "化学元素半导体", 10); err != nil || len(got) == 0 || got[0].EntryID != "1" {
		t.Fatalf("long-query fallback got %#v, %v", got, err)
	}
}

func TestImporterValidationAndAtomicReplace(t *testing.T) {
	root := t.TempDir()
	dictionary := filepath.Join(root, "dictionary.db")
	if err := os.WriteFile(dictionary, []byte("primary"), 0600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "reverse.db")
	valid := []SearchDocument{doc("1", ScopeSense, "one", "一个定义")}
	importSidecar(t, dictionary, target, valid, false)
	before, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if err := Import(context.Background(), config(dictionary, target, strings.NewReader("{bad\n"), true)); err == nil {
		t.Fatal("malformed projection was accepted")
	}
	after, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("failed import replaced target")
	}
	if err := Import(context.Background(), config(dictionary, target, strings.NewReader(`{"dictionaryId":"d","entryId":"1","scope":"bad","headword":"x","englishText":"x","chineseText":"中文","location":{"section":"definitions"},"weight":0}`+"\n"), true)); err == nil {
		t.Fatal("unknown scope was accepted")
	}
	tooLong := strings.Repeat("a", maxLineBytes+1)
	if err := Import(context.Background(), config(dictionary, target, strings.NewReader(tooLong), true)); err == nil {
		t.Fatal("oversized line was accepted")
	}
	unsorted := ndjson(t, []SearchDocument{doc("2", ScopeSense, "two", "两个定义"), doc("1", ScopeSense, "one", "一个定义")})
	if err := Import(context.Background(), config(dictionary, target, strings.NewReader(unsorted), true)); err == nil {
		t.Fatal("unsorted entry IDs were accepted")
	}
	importSidecar(t, dictionary, target, []SearchDocument{doc("1", ScopeSense, "replacement", "替换结果")}, true)
	store, err := Open(target, digest(t, dictionary))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	got, err := store.Search(context.Background(), "替换结果", 10)
	if err != nil || len(got) != 1 {
		t.Fatalf("atomic replacement got %#v, %v", got, err)
	}
}

func TestOpenFingerprintAndSchemaValidation(t *testing.T) {
	root := t.TempDir()
	dictionary := filepath.Join(root, "dictionary.db")
	if err := os.WriteFile(dictionary, []byte("primary"), 0600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "reverse.db")
	importSidecar(t, dictionary, target, []SearchDocument{doc("1", ScopeSense, "one", "一个定义")}, false)
	if _, err := Open(target, strings.Repeat("0", 64)); err == nil {
		t.Fatal("fingerprint mismatch was accepted")
	}
	db, err := sql.Open("sqlite", target)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE metadata SET value = '999' WHERE key = 'schema_version'`); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(target, digest(t, dictionary)); err == nil {
		t.Fatal("schema mismatch was accepted")
	}
}

func TestIndexesAndCancellation(t *testing.T) {
	root := t.TempDir()
	dictionary := filepath.Join(root, "dictionary.db")
	if err := os.WriteFile(dictionary, []byte("primary"), 0600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "reverse.db")
	importSidecar(t, dictionary, target, []SearchDocument{doc("1", ScopeSense, "one", "一个定义")}, false)
	db, err := sql.Open("sqlite", target)
	if err != nil {
		t.Fatal(err)
	}
	var indexSQL string
	if err := db.QueryRow(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'documents_by_entry'`).Scan(&indexSQL); err != nil || !strings.Contains(indexSQL, "entry_id") {
		t.Fatalf("entry index missing: %q, %v", indexSQL, err)
	}
	var ftsSQL string
	if err := db.QueryRow(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'documents_fts'`).Scan(&ftsSQL); err != nil || !strings.Contains(ftsSQL, "detail=none") {
		t.Fatalf("FTS schema missing: %q, %v", ftsSQL, err)
	}
	db.Close()
	store, err := Open(target, digest(t, dictionary))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := store.Search(ctx, "一个定义", 10); err == nil {
		t.Fatal("cancelled query succeeded")
	}
}

func TestNormalizationAndBoundedCandidateFiltering(t *testing.T) {
	if got := normalizeChinese("Ａ，矽　肺"); got != "A 硅 肺" {
		t.Fatalf("normalized text = %q", got)
	}
	matcher := newCommonRunMatcher([]rune("火山硅肺病"))
	if got := matcher.longest([]rune("一种严重硅肺病")); got != 3 {
		t.Fatalf("longest common run = %d, want 3", got)
	}

	root := t.TempDir()
	dictionary := filepath.Join(root, "dictionary.db")
	if err := os.WriteFile(dictionary, []byte("primary"), 0600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "reverse.db")
	importSidecar(t, dictionary, target, []SearchDocument{
		doc("1", ScopeSense, "lung disease", "一种硅肺病"),
		doc("2", ScopeSense, "mountain", "一座火山"),
		doc("3", ScopeSense, "unrelated", "肺部检查"),
	}, false)
	store, err := Open(target, digest(t, dictionary))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if got, err := store.Search(context.Background(), "火山矽肺病", 10); err != nil || len(got) != 1 || got[0].EntryID != "1" {
		t.Fatalf("long-query fragment fallback got %#v, %v", got, err)
	}
	if got, err := store.Search(context.Background(), "火山", 10); err != nil || len(got) != 1 || got[0].EntryID != "2" {
		t.Fatalf("two-rune filtering got %#v, %v", got, err)
	}
}

func doc(entryID string, scope Scope, headword, chinese string) SearchDocument {
	weights := map[Scope]int{ScopeSense: 100, ScopePhrase: 100, ScopeUsage: 60, ScopeForm: 60, ScopeExample: 30}
	return SearchDocument{DictionaryID: "oalecd", EntryID: entryID, Scope: scope, Headword: headword, EnglishText: headword + " English", ChineseText: chinese, Location: Location{Section: SectionDefinitions, Path: []string{"sense", entryID}}, Weight: weights[scope]}
}

func config(dictionary, target string, source *strings.Reader, replace bool) ImportConfig {
	return ImportConfig{Documents: source, DictionaryPath: dictionary, TargetPath: target, SourceVersion: "source-v1", ProjectionVersion: ProjectionVersion, Replace: replace}
}

func importSidecar(t *testing.T, dictionary, target string, documents []SearchDocument, replace bool) {
	t.Helper()
	if err := Import(context.Background(), config(dictionary, target, strings.NewReader(ndjson(t, documents)), replace)); err != nil {
		t.Fatal(err)
	}
}

func ndjson(t *testing.T, documents []SearchDocument) string {
	t.Helper()
	var output strings.Builder
	for _, document := range documents {
		line, err := json.Marshal(document)
		if err != nil {
			t.Fatal(err)
		}
		output.Write(line)
		output.WriteByte('\n')
	}
	return output.String()
}

func digest(t *testing.T, path string) string {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	value := sha256.Sum256(content)
	return hex.EncodeToString(value[:])
}
