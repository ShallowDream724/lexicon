package reversesearch

import (
	"bytes"
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestImportStoresDeduplicatedHeadwordFormsAndBatchLookup(t *testing.T) {
	root := t.TempDir()
	dictionary := filepath.Join(root, "dictionary.db")
	if err := os.WriteFile(dictionary, []byte("primary"), 0600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "reverse.db")
	first := doc("1", ScopeSense, "think", "思考")
	first.HeadwordForms = []string{"  thought\t", "thinks", "thought"}
	second := doc("1", ScopeExample, "think", "认真思考")
	second.HeadwordForms = []string{"thought", "thinks"}
	withoutForms := doc("2", ScopeSense, "plain", "普通的")
	twisted := doc("3", ScopeSense, "twist", "扭转")
	twisted.HeadwordForms = []string{"twisted"}
	importSidecar(t, dictionary, target, []SearchDocument{first, second, withoutForms, twisted}, false)

	db, err := sql.Open("sqlite", target)
	if err != nil {
		t.Fatal(err)
	}
	var tableSQL string
	if err := db.QueryRow(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'entry_headword_forms'`).Scan(&tableSQL); err != nil || !strings.Contains(tableSQL, "WITHOUT ROWID") {
		t.Fatalf("headword-form table schema = %q, %v", tableSQL, err)
	}
	var formCount, documentColumnCount int
	if err := db.QueryRow(`SELECT COUNT(*) FROM entry_headword_forms`).Scan(&formCount); err != nil || formCount != 3 {
		t.Fatalf("stored form count = %d, %v", formCount, err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('documents') WHERE name = 'headword_forms'`).Scan(&documentColumnCount); err != nil || documentColumnCount != 0 {
		t.Fatalf("headword forms leaked into documents: count=%d, err=%v", documentColumnCount, err)
	}
	var storedCount string
	if err := db.QueryRow(`SELECT value FROM metadata WHERE key = 'form_count'`).Scan(&storedCount); err != nil || storedCount != "3" {
		t.Fatalf("form_count metadata = %q, %v", storedCount, err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	store, err := Open(target, digest(t, dictionary))
	if err != nil {
		t.Fatal(err)
	}
	forms, err := store.HeadwordForms(context.Background(), []string{"3", "1", "1", "2", "missing"})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string][]string{"1": {"thinks", "thought"}, "3": {"twisted"}}
	if !reflect.DeepEqual(forms, want) {
		t.Fatalf("headword forms = %#v, want %#v", forms, want)
	}
	empty, err := store.HeadwordForms(context.Background(), nil)
	if err != nil || len(empty) != 0 || empty == nil {
		t.Fatalf("empty lookup = %#v, %v", empty, err)
	}
	if _, err := store.HeadwordForms(context.Background(), []string{" "}); err == nil {
		t.Fatal("invalid entry id was accepted")
	}
	var unavailable *Store
	if _, err := unavailable.HeadwordForms(context.Background(), []string{"1"}); err == nil {
		t.Fatal("unavailable store accepted a non-empty lookup")
	}
	tooMany := make([]string, maxResults+1)
	for index := range tooMany {
		tooMany[index] = fmt.Sprintf("entry-%03d", index)
	}
	if _, err := store.HeadwordForms(context.Background(), tooMany); err == nil {
		t.Fatal("oversized batch was accepted")
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := store.HeadwordForms(cancelled, []string{"1"}); err == nil {
		t.Fatal("cancelled lookup succeeded")
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	db, err = sql.Open("sqlite", target)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE metadata SET value = '99' WHERE key = 'form_count'`); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(target, digest(t, dictionary)); err == nil {
		t.Fatal("invalid form_count metadata was accepted")
	}
}

func TestImportAcceptsLegacyDocumentsWithoutHeadwordForms(t *testing.T) {
	root := t.TempDir()
	dictionary := filepath.Join(root, "dictionary.db")
	if err := os.WriteFile(dictionary, []byte("primary"), 0600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "reverse.db")
	legacy := `{"dictionaryId":"d","entryId":"1","scope":"sense","headword":"one","englishText":"one","chineseText":"一个定义","semanticRole":"definition","location":{"section":"definitions","path":["senses","0"]},"weight":1}` + "\n"
	if err := Import(context.Background(), config(dictionary, target, strings.NewReader(legacy), false)); err != nil {
		t.Fatal(err)
	}
	store, err := Open(target, digest(t, dictionary))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	forms, err := store.HeadwordForms(context.Background(), []string{"1"})
	if err != nil || len(forms) != 0 {
		t.Fatalf("legacy document forms = %#v, %v", forms, err)
	}
}

func TestImportRejectsMalformedHeadwordForms(t *testing.T) {
	root := t.TempDir()
	dictionary := filepath.Join(root, "dictionary.db")
	if err := os.WriteFile(dictionary, []byte("primary"), 0600); err != nil {
		t.Fatal(err)
	}

	validDocument := doc("1", ScopeSense, "one", "一个定义")
	tooMany := validDocument
	tooMany.HeadwordForms = make([]string, maxHeadwordForms+1)
	for index := range tooMany.HeadwordForms {
		tooMany.HeadwordForms[index] = fmt.Sprintf("form-%02d", index)
	}
	oversized := validDocument
	oversized.HeadwordForms = []string{strings.Repeat("a", maxIDBytes+1)}
	blank := validDocument
	blank.HeadwordForms = []string{"\t "}

	cases := []struct {
		name    string
		source  []byte
		message string
	}{
		{name: "too many", source: []byte(ndjson(t, []SearchDocument{tooMany})), message: "exceeds 64 items"},
		{name: "oversized", source: []byte(ndjson(t, []SearchDocument{oversized})), message: "invalid or oversized"},
		{name: "blank", source: []byte(ndjson(t, []SearchDocument{blank})), message: "invalid or oversized"},
		{name: "invalid UTF-8", source: invalidUTF8Projection(), message: "invalid UTF-8"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			target := filepath.Join(root, strings.ReplaceAll(test.name, " ", "-")+".db")
			importConfig := ImportConfig{
				Documents:         bytes.NewReader(test.source),
				DictionaryPath:    dictionary,
				TargetPath:        target,
				SourceVersion:     "source-v1",
				ProjectionVersion: ProjectionVersion,
			}
			err := Import(context.Background(), importConfig)
			if err == nil || !strings.Contains(err.Error(), test.message) {
				t.Fatalf("Import error = %v, want %q", err, test.message)
			}
			if _, statErr := os.Stat(target); !os.IsNotExist(statErr) {
				t.Fatalf("failed import left target behind: %v", statErr)
			}
		})
	}
}

func invalidUTF8Projection() []byte {
	prefix := []byte(`{"dictionaryId":"d","entryId":"1","scope":"sense","headword":"one","headwordForms":["`)
	suffix := []byte(`"],"englishText":"one","chineseText":"一个定义","location":{"section":"definitions"},"weight":1}` + "\n")
	return append(append(prefix, 0xff), suffix...)
}
