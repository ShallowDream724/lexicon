package etymology

import (
	"bytes"
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

func TestImportCreatesDeterministicIsolatedSidecar(t *testing.T) {
	directory := t.TempDir()
	sourcePath := filepath.Join(directory, "source.db")
	createEtymologySource(t, sourcePath)
	firstPath := filepath.Join(directory, "first.db")
	secondPath := filepath.Join(directory, "second.db")
	for _, targetPath := range []string{firstPath, secondPath} {
		if err := Import(context.Background(), ImportConfig{SourcePath: sourcePath, TargetPath: targetPath, SourceVersion: "fixture-etymology-v1"}); err != nil {
			t.Fatal(err)
		}
	}

	readArtifacts := func(path string) ([]byte, []byte) {
		db, err := sql.Open("sqlite", path)
		if err != nil {
			t.Fatal(err)
		}
		defer db.Close()
		var dictionary, article []byte
		if err := db.QueryRow(`SELECT blob_value FROM etymology_metadata WHERE key = 'payload_dictionary'`).Scan(&dictionary); err != nil {
			t.Fatal(err)
		}
		if err := db.QueryRow(`SELECT payload FROM etymology_articles WHERE id = '101'`).Scan(&article); err != nil {
			t.Fatal(err)
		}
		var sourceTables int
		if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('word_index_etymapp', 'vocabulary_etymapp')`).Scan(&sourceTables); err != nil {
			t.Fatal(err)
		}
		if sourceTables != 0 {
			t.Fatal("sidecar retained source application tables")
		}
		return dictionary, article
	}
	firstDictionary, firstArticle := readArtifacts(firstPath)
	secondDictionary, secondArticle := readArtifacts(secondPath)
	if !bytes.Equal(firstDictionary, secondDictionary) || !bytes.Equal(firstArticle, secondArticle) {
		t.Fatal("identical imports produced different payload artifacts")
	}

	source, err := sql.Open("sqlite", sourcePath)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close()
	var sourceWord string
	if err := source.QueryRow(`SELECT word FROM word_index_etymapp WHERE id = 1`).Scan(&sourceWord); err != nil || sourceWord != "Alpha" {
		t.Fatalf("source database changed: word=%q err=%v", sourceWord, err)
	}

	store, err := Open(firstPath)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	summary, err := store.Summary(context.Background(), "alpha")
	if err != nil {
		t.Fatal(err)
	}
	if summary == nil || summary.Term != "Alpha" || summary.ResourceID != "etymology:alpha" || len(summary.Articles) != 2 || summary.Articles[0].Label != "adj., adv." || summary.Articles[1].Label != "" {
		t.Fatalf("unexpected summary: %#v", summary)
	}
	dottedSummary, err := store.Summary(context.Background(), "Al·pha")
	if err != nil || dottedSummary == nil || dottedSummary.ResourceID != summary.ResourceID {
		t.Fatalf("display-separated summary: summary=%#v err=%v", dottedSummary, err)
	}
	if len(summary.Articles[0].PreviewRuns) < 2 || textFromRuns(summary.Articles[0].PreviewRuns) != summary.Articles[0].Preview {
		t.Fatalf("semantic preview projection was not retained: %#v", summary.Articles[0])
	}
	var previewMarks []byte
	if err := store.db.QueryRow(`SELECT preview_marks FROM etymology_articles WHERE id = '101'`).Scan(&previewMarks); err != nil || len(previewMarks) != previewMarkRecordSize {
		t.Fatalf("semantic preview marks were not stored compactly: bytes=%d err=%v", len(previewMarks), err)
	}
	orphanSummary, err := store.Summary(context.Background(), "unindexed")
	if err != nil || orphanSummary == nil || len(orphanSummary.Articles) != 1 || orphanSummary.Articles[0].ID != "301" {
		t.Fatalf("unindexed source article was not retained: summary=%#v err=%v", orphanSummary, err)
	}
}

func TestStoreSummaryDoesNotDecodeArticlesAndArticleValidatesIntegrity(t *testing.T) {
	directory := t.TempDir()
	sourcePath := filepath.Join(directory, "source.db")
	targetPath := filepath.Join(directory, "sidecar.db")
	createEtymologySource(t, sourcePath)
	if err := Import(context.Background(), ImportConfig{SourcePath: sourcePath, TargetPath: targetPath, SourceVersion: "fixture-etymology-v1"}); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", targetPath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE etymology_articles SET payload = x'00' WHERE id = '101'`); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	store, err := Open(targetPath)
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if summary, err := store.Summary(context.Background(), "Alpha"); err != nil || summary == nil || len(summary.Articles) != 2 {
		t.Fatalf("summary must not decode articles: summary=%#v err=%v", summary, err)
	}
	if article, err := store.Article(context.Background(), "101"); err == nil || article != nil {
		t.Fatalf("corrupt article result = %#v, %v", article, err)
	}
}

func TestParseHTMLPreservesNestedMarksLinksAndToleratedFragments(t *testing.T) {
	document, err := ParseHTML(`<p>Alpha <span class="foreign">Latin <strong>firm <a href="/word/Target%20Term#123">linked</a></strong></span><a href="/word/"></a><a href="/word/Gamma">gamma</a><a href="/word/<strong>castration</strong>"><strong>castration</strong></a><a href="https://example.test/reference" rel="nofollow" target="_blank">external</a><span class="ql-cursor">.</span></p><blockquote class="poetry"><p>First</blockquote><p>Second</p>`)
	if err != nil {
		t.Fatal(err)
	}
	if len(document.Blocks) < 2 || document.Blocks[1].Kind != "quote" {
		t.Fatalf("unexpected blocks: %#v", document.Blocks)
	}
	var linked, gamma, recovered, external *TextRun
	for blockIndex := range document.Blocks {
		for runIndex := range document.Blocks[blockIndex].Runs {
			run := &document.Blocks[blockIndex].Runs[runIndex]
			switch {
			case run.Text == "linked":
				linked = run
			case run.Text == "gamma":
				gamma = run
			case run.Text == "castration":
				recovered = run
			case strings.Contains(run.Text, "external"):
				external = run
			}
		}
	}
	if linked == nil || linked.Link == nil || linked.Link.TargetTerm != "Target Term" || linked.Link.TargetArticleID != "123" || !hasMarks(linked.Marks, "foreign", "strong") {
		t.Fatalf("nested internal link was lost: %#v", linked)
	}
	if gamma == nil || gamma.Link == nil || gamma.Link.TargetTerm != "Gamma" || gamma.Link.TargetArticleID != "" || len(gamma.Marks) != 0 {
		t.Fatalf("plain internal link was lost: %#v", gamma)
	}
	if recovered == nil || recovered.Link == nil || recovered.Link.TargetTerm != "castration" || !hasMarks(recovered.Marks, "strong") {
		t.Fatalf("malformed internal link target was not recovered: %#v", recovered)
	}
	if external == nil || external.Link != nil || len(external.Marks) != 0 {
		t.Fatalf("external link was not reduced to ordinary text: %#v", external)
	}
	if !strings.Contains(Preview(document), "external.") {
		t.Fatalf("ql-cursor text was lost: %q", Preview(document))
	}
	if !strings.Contains(Preview(document), "First") || !strings.Contains(Preview(document), "Second") {
		t.Fatalf("malformed poetry lost text: %q", Preview(document))
	}
	previewRuns := PreviewRuns(document)
	var previewForeign *TextRun
	for index := range previewRuns {
		if strings.Contains(previewRuns[index].Text, "Latin") {
			previewForeign = &previewRuns[index]
			break
		}
	}
	if previewForeign == nil || !hasMarks(previewForeign.Marks, "foreign") {
		t.Fatalf("semantic preview lost foreign emphasis: %#v", previewRuns)
	}
	encoded, err := encodePreviewMarks(previewRuns)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := decodePreviewMarks(Preview(document), encoded)
	if err != nil || textFromRuns(decoded) != Preview(document) {
		t.Fatalf("semantic preview mark round trip failed: runs=%#v err=%v", decoded, err)
	}
}

func TestPreviewProjectionSupportsLongCardBudgets(t *testing.T) {
	document := Document{Blocks: []Block{{Kind: "paragraph", Runs: []TextRun{
		{Text: strings.Repeat("a", 300)},
		{Text: strings.Repeat("b", 80), Marks: []string{"foreign"}},
		{Text: strings.Repeat("c", 300)},
	}}}}
	runs := PreviewRuns(document)
	preview := textFromRuns(runs)
	if len([]rune(preview)) != previewLimit || !strings.HasSuffix(preview, "...") {
		t.Fatalf("unexpected bounded preview: runes=%d suffix=%q", len([]rune(preview)), preview[len(preview)-3:])
	}
	encoded, err := encodePreviewMarks(runs)
	if err != nil {
		t.Fatal(err)
	}
	if len(encoded) != previewMarkRecordSize {
		t.Fatalf("long preview mark bytes = %d", len(encoded))
	}
	decoded, err := decodePreviewMarks(preview, encoded)
	if err != nil || textFromRuns(decoded) != preview {
		t.Fatalf("long preview mark round trip failed: runs=%#v err=%v", decoded, err)
	}
	if len(decoded) < 3 || len([]rune(decoded[1].Text)) != 80 || !hasMarks(decoded[1].Marks, "foreign") {
		t.Fatalf("long preview mark range was not retained: %#v", decoded)
	}
}

func TestParseHTMLRejectsUnknownStructuralMarkup(t *testing.T) {
	if _, err := ParseHTML(`<p>before <em>unsupported</em></p>`); err == nil || !strings.Contains(err.Error(), "unsupported structural tag <em>") {
		t.Fatalf("unsupported markup error = %v", err)
	}
}

func hasMarks(marks []string, wanted ...string) bool {
	if len(marks) != len(wanted) {
		return false
	}
	for index, mark := range wanted {
		if marks[index] != mark {
			return false
		}
	}
	return true
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
	`); err != nil {
		t.Fatal(err)
	}
	for _, term := range []struct {
		id                   int
		word, lowercase, ids string
	}{
		{1, "Alpha", "alpha", `[101,102]`},
		{2, "Etymo Only", "etymo-only", `[201]`},
	} {
		if _, err := db.Exec(`INSERT INTO word_index_etymapp (id, word, lowercase, word_ids, summary, related_words) VALUES (?, ?, ?, ?, '', '')`, term.id, term.word, term.lowercase, term.ids); err != nil {
			t.Fatal(err)
		}
	}
	for _, article := range []struct {
		id, position         int
		word, property, html string
	}{
		{101, 1, "Alpha", "(adj., adv.)", `<p>Alpha <span class="foreign">Latin</span> <a href="/word/beta#102">beta</a></p>`},
		{102, 2, "Alpha", "", `<blockquote class="poetry">A quoted line</blockquote>`},
		{201, 1, "Etymo Only", "(only)", `<p>Independent origin</p>`},
		{301, 1, "Unindexed", "(orphan)", `<p>Valid unindexed origin</p>`},
	} {
		if _, err := db.Exec(`INSERT INTO vocabulary_etymapp (id, word, type, sort, etymology, property, graph_key) VALUES (?, ?, 'entry', ?, ?, ?, '')`, article.id, article.word, article.position, article.html, article.property); err != nil {
			t.Fatal(err)
		}
	}
}
