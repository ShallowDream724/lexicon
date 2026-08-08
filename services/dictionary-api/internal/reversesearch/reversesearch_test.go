package reversesearch

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
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

	groups, err := store.Search(context.Background(), "矽是一种化学元素", allOptions(10))
	if err != nil {
		t.Fatal(err)
	}
	if len(groups) == 0 || groups[0].EntryID != "1" || groups[0].Matches[0].Scope != ScopeSense {
		t.Fatalf("unexpected exact search %#v", groups)
	}
	if len(groups[0].Matches) > maxMatches {
		t.Fatalf("match limit ignored: %#v", groups[0])
	}
	if got, err := store.Search(context.Background(), "科技产业", allOptions(10)); err != nil || len(got) != 1 || got[0].EntryID != "2" {
		t.Fatalf("phrase search got %#v, %v", got, err)
	}
	if got, err := store.Search(context.Background(), "abc", allOptions(10)); err != nil || len(got) != 0 {
		t.Fatalf("non-CJK search got %#v, %v", got, err)
	}
	if got, err := store.Search(context.Background(), "硅", allOptions(10)); err != nil || len(got) == 0 || got[0].Matches[0].Scope == ScopeExample {
		t.Fatalf("single rune search got %#v, %v", got, err)
	}
	if got, err := store.Search(context.Background(), "化学元素半导体", allOptions(10)); err != nil || len(got) == 0 || got[0].EntryID != "1" {
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
	got, err := store.Search(context.Background(), "替换结果", allOptions(10))
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
	var entryIndexCount int
	if err := db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'documents_by_entry'`).Scan(&entryIndexCount); err != nil || entryIndexCount != 0 {
		t.Fatalf("unused entry index is present: count=%d, err=%v", entryIndexCount, err)
	}
	var ftsSQL string
	if err := db.QueryRow(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'documents_fts'`).Scan(&ftsSQL); err != nil || !strings.Contains(ftsSQL, "detail=none") {
		t.Fatalf("FTS schema missing: %q, %v", ftsSQL, err)
	}
	var exactSegmentsSQL string
	if err := db.QueryRow(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'exact_segments'`).Scan(&exactSegmentsSQL); err != nil || !strings.Contains(exactSegmentsSQL, "WITHOUT ROWID") {
		t.Fatalf("exact-segment index missing: %q, %v", exactSegmentsSQL, err)
	}
	ftsPlan := explainPlan(t, db, `
		EXPLAIN QUERY PLAN
		SELECT d.id
		FROM documents_fts
		JOIN documents d ON d.id = documents_fts.rowid
		WHERE documents_fts MATCH ? AND d.scope IN (?,?,?)
		ORDER BY bm25(documents_fts) - (d.weight * 0.01), d.entry_id, d.id
		LIMIT ?`, matchExpression(queryTokens("一个定义")), ScopeSense, ScopePhrase, ScopeForm, defaultCandidates)
	if !strings.Contains(ftsPlan, "VIRTUAL TABLE INDEX") || !strings.Contains(ftsPlan, "SEARCH d USING INTEGER PRIMARY KEY") {
		t.Fatalf("unexpected scoped FTS query plan: %s", ftsPlan)
	}
	exactPlan := explainPlan(t, db, `
		EXPLAIN QUERY PLAN
		SELECT d.id
		FROM exact_segments x
		JOIN documents d ON d.id = x.document_id
		WHERE x.normalized = ? AND d.scope IN (?,?,?)
		ORDER BY d.weight DESC, d.entry_id, d.id
		LIMIT ?`, "一个定义", ScopeSense, ScopePhrase, ScopeForm, defaultCandidates)
	if !strings.Contains(exactPlan, "SEARCH x USING PRIMARY KEY") || !strings.Contains(exactPlan, "SEARCH d USING INTEGER PRIMARY KEY") {
		t.Fatalf("unexpected scoped exact query plan: %s", exactPlan)
	}
	db.Close()
	store, err := Open(target, digest(t, dictionary))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := store.Search(ctx, "一个定义", allOptions(10)); err == nil {
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
	if got, err := store.Search(context.Background(), "火山矽肺病", allOptions(10)); err != nil || len(got) != 1 || got[0].EntryID != "1" {
		t.Fatalf("long-query fragment fallback got %#v, %v", got, err)
	}
	if got, err := store.Search(context.Background(), "火山", allOptions(10)); err != nil || len(got) != 1 || got[0].EntryID != "2" {
		t.Fatalf("two-rune filtering got %#v, %v", got, err)
	}
}

func TestQueryTokensRetainSingletonSegments(t *testing.T) {
	got := queryTokens("硅，火山")
	want := []string{encodeRune('硅'), encodeBigram('火', '山')}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("query tokens = %#v, want %#v", got, want)
	}
}

func TestSearchPrefersACompleteTranslationSegmentOverIncidentalContainment(t *testing.T) {
	root := t.TempDir()
	dictionary := filepath.Join(root, "dictionary.db")
	if err := os.WriteFile(dictionary, []byte("primary"), 0600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "reverse.db")
	importSidecar(t, dictionary, target, []SearchDocument{
		doc("1", ScopeSense, "snow day", "大雪休息日，大雪假"),
		doc("2", ScopeSense, "rest", "休息；歇息"),
		doc("3", ScopeSense, "break", "间歇；休息"),
	}, false)
	store, err := Open(target, digest(t, dictionary))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	got, err := store.Search(context.Background(), "休息", allOptions(10))
	if err != nil || len(got) != 3 {
		t.Fatalf("translation ranking got %#v, %v", got, err)
	}
	if got[0].Headword == "snow day" || got[1].Headword == "snow day" {
		t.Fatalf("incidental containment outranked complete segments: %#v", got)
	}
}

func TestSearchDoesNotMatchAcrossTranslationBoundaries(t *testing.T) {
	root := t.TempDir()
	dictionary := filepath.Join(root, "dictionary.db")
	if err := os.WriteFile(dictionary, []byte("primary"), 0600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "reverse.db")
	importSidecar(t, dictionary, target, []SearchDocument{
		doc("1", ScopeSense, "volcano lung disease", "火山；肺病"),
		doc("2", ScopeSense, "mountain lung", "山肺"),
	}, false)
	store, err := Open(target, digest(t, dictionary))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	got, err := store.Search(context.Background(), "山肺", allOptions(10))
	if err != nil || len(got) != 1 || got[0].EntryID != "2" {
		t.Fatalf("cross-boundary match got %#v, %v", got, err)
	}
}

func TestSearchUsesPartialCandidatesOnlyWhenNoCompleteTokenMatchExists(t *testing.T) {
	root := t.TempDir()
	dictionary := filepath.Join(root, "dictionary.db")
	if err := os.WriteFile(dictionary, []byte("primary"), 0600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "reverse.db")
	importSidecar(t, dictionary, target, []SearchDocument{
		doc("1", ScopeSense, "confidant", "完全受某人信任"),
		doc("2", ScopePhrase, "under somebody's thumb", "完全受某人控制；受制于人"),
		doc("3", ScopeSense, "silicosis", "一种严重硅肺病"),
		doc("4", ScopeSense, "volcano", "火山"),
		doc("5", ScopeSense, "silicon volcano", "硅火山"),
	}, false)
	store, err := Open(target, digest(t, dictionary))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	got, err := store.Search(context.Background(), "完全受某人控制", allOptions(10))
	if err != nil || len(got) != 1 || got[0].EntryID != "2" {
		t.Fatalf("precision-first search got %#v, %v", got, err)
	}
	got, err = store.Search(context.Background(), "火山硅肺病", allOptions(10))
	if err != nil || len(got) != 1 || got[0].EntryID != "3" {
		t.Fatalf("partial fallback search got %#v, %v", got, err)
	}
	got, err = store.Search(context.Background(), "硅，火山", allOptions(10))
	if err != nil || len(got) != 1 || got[0].EntryID != "5" {
		t.Fatalf("singleton-segment search got %#v, %v", got, err)
	}
}

func TestExactSegmentIndexRescuesCanonicalShortTranslations(t *testing.T) {
	root := t.TempDir()
	dictionary := filepath.Join(root, "dictionary.db")
	if err := os.WriteFile(dictionary, []byte("primary"), 0600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "reverse.db")
	documents := make([]SearchDocument, 0, defaultCandidates+17)
	for index := 0; index < defaultCandidates+16; index++ {
		document := doc(fmt.Sprintf("d%05d", index), ScopeSense, fmt.Sprintf("volume-%05d", index), "书中的内容")
		documents = append(documents, document)
	}
	exact := doc("z-exact", ScopeSense, "book", "书")
	exact.Weight = 30
	documents = append(documents, exact)
	importSidecar(t, dictionary, target, documents, false)
	store, err := Open(target, digest(t, dictionary))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	got, err := store.Search(context.Background(), "书", allOptions(5))
	if err != nil || len(got) == 0 || got[0].EntryID != "z-exact" {
		t.Fatalf("exact short translation was lost outside the FTS window: %#v, %v", got, err)
	}
}

func TestConciseCanonicalTranslationsOutrankIncidentalSegments(t *testing.T) {
	root := t.TempDir()
	dictionary := filepath.Join(root, "dictionary.db")
	if err := os.WriteFile(dictionary, []byte("primary"), 0600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "reverse.db")
	importSidecar(t, dictionary, target, []SearchDocument{
		doc("01", ScopeSense, "true crime", "真实罪案（书、电影等的一种类型）"),
		doc("02", ScopeSense, "book", "书；书籍"),
		doc("03", ScopeSense, "A-list", "第一等的；最出名（或成功、重要）的"),
		doc("04", ScopeSense, "important", "重要的；有重大影响的；有巨大价值的"),
		doc("05", ScopePhrase, "break", "（学校）期终放假"),
		doc("06", ScopeSense, "school", "（中、小）学校"),
	}, false)
	store, err := Open(target, digest(t, dictionary))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	for query, wanted := range map[string]string{"书": "02", "重要": "04", "学校": "06"} {
		got, err := store.Search(context.Background(), query, allOptions(5))
		if err != nil || len(got) == 0 || got[0].EntryID != wanted {
			t.Fatalf("query %q ranked %#v, %v", query, got, err)
		}
	}
}

func TestLongPartialFallbackRejectsWeakAndOppositePolarityMatches(t *testing.T) {
	root := t.TempDir()
	dictionary := filepath.Join(root, "dictionary.db")
	if err := os.WriteFile(dictionary, []byte("primary"), 0600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "reverse.db")
	importSidecar(t, dictionary, target, []SearchDocument{
		doc("1", ScopeExample, "meeting", "他今天参加会议"),
		doc("2", ScopeExample, "badly", "事情进展得很不顺利"),
	}, false)
	store, err := Open(target, digest(t, dictionary))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	if got, err := store.Search(context.Background(), "他决定推迟会议", allOptions(10)); err != nil || len(got) != 0 {
		t.Fatalf("weak long-query fragment was returned: %#v, %v", got, err)
	}
	if got, err := store.Search(context.Background(), "事情进展得很顺利", allOptions(10)); err != nil || len(got) != 0 {
		t.Fatalf("opposite-polarity fragment was returned: %#v, %v", got, err)
	}
}

func TestMixedChineseQueriesRetainASCIIConstraints(t *testing.T) {
	root := t.TempDir()
	dictionary := filepath.Join(root, "dictionary.db")
	if err := os.WriteFile(dictionary, []byte("primary"), 0600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "reverse.db")
	importSidecar(t, dictionary, target, []SearchDocument{
		doc("1", ScopeSense, "DNA polymerase", "DNA聚合酶"),
		doc("2", ScopeSense, "polymerase", "聚合酶"),
	}, false)
	store, err := Open(target, digest(t, dictionary))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	got, err := store.Search(context.Background(), "DNA聚合酶", allOptions(10))
	if err != nil || len(got) != 1 || got[0].EntryID != "1" {
		t.Fatalf("mixed query dropped its ASCII constraint: %#v, %v", got, err)
	}
	if got, err := store.Search(context.Background(), "RNA聚合酶", allOptions(10)); err != nil || len(got) != 0 {
		t.Fatalf("unavailable mixed query returned a weaker Chinese-only match: %#v, %v", got, err)
	}
}

func TestSearchPageReturnsStableNonOverlappingWindows(t *testing.T) {
	root := t.TempDir()
	dictionary := filepath.Join(root, "dictionary.db")
	if err := os.WriteFile(dictionary, []byte("primary"), 0600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "reverse.db")
	documents := make([]SearchDocument, 0, 70)
	for index := 0; index < 70; index++ {
		documents = append(documents, doc(fmt.Sprintf("%03d", index), ScopeSense, fmt.Sprintf("entry-%03d", index), "共同释义"))
	}
	importSidecar(t, dictionary, target, documents, false)
	store, err := Open(target, digest(t, dictionary))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	first, err := store.SearchPage(context.Background(), "共同释义", Options{Limit: 32, Scopes: AllScopeFilter()})
	if err != nil || len(first.Groups) != 32 || !first.HasMore || first.NextOffset != 32 {
		t.Fatalf("first page = %#v, %v", first, err)
	}
	second, err := store.SearchPage(context.Background(), "共同释义", Options{Offset: first.NextOffset, Limit: 32, Scopes: AllScopeFilter()})
	if err != nil || len(second.Groups) != 32 || !second.HasMore || second.NextOffset != 64 {
		t.Fatalf("second page = %#v, %v", second, err)
	}
	seen := make(map[string]struct{}, 64)
	for _, group := range append(first.Groups, second.Groups...) {
		if _, duplicate := seen[group.EntryID]; duplicate {
			t.Fatalf("entry %q repeated across pages", group.EntryID)
		}
		seen[group.EntryID] = struct{}{}
	}
}

func TestSearchRejectsOversizedDirectQueries(t *testing.T) {
	store := &Store{db: &sql.DB{}}
	if _, err := store.Search(context.Background(), strings.Repeat("中", maxQueryRunes+1), allOptions(10)); err == nil {
		t.Fatal("oversized direct query was accepted")
	}
}

func TestScopeFilterCanonicalizesAndSearchPagesRemainScoped(t *testing.T) {
	filter, err := ParseScopeFilter("form,sense,sense,phrase")
	if err != nil {
		t.Fatal(err)
	}
	if got := filter.String(); got != "sense,phrase,form" {
		t.Fatalf("canonical filter = %q", got)
	}
	for _, invalid := range []string{"", "sense,", ",sense", "sense, usage", "unknown"} {
		if _, err := ParseScopeFilter(invalid); err == nil {
			t.Errorf("invalid scope %q was accepted", invalid)
		}
	}

	root := t.TempDir()
	dictionary := filepath.Join(root, "dictionary.db")
	if err := os.WriteFile(dictionary, []byte("primary"), 0600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "reverse.db")
	importSidecar(t, dictionary, target, []SearchDocument{
		doc("1", ScopeSense, "sense", "共同范围"),
		doc("2", ScopePhrase, "phrase", "共同范围"),
		doc("3", ScopeForm, "form", "共同范围"),
		doc("4", ScopeUsage, "usage", "共同范围"),
		doc("5", ScopeExample, "example", "共同范围"),
	}, false)
	store, err := Open(target, digest(t, dictionary))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	first, err := store.SearchPage(context.Background(), "共同范围", Options{Limit: 2, Scopes: filter})
	if err != nil || len(first.Groups) != 2 || !first.HasMore || first.NextOffset != 2 {
		t.Fatalf("first scoped page = %#v, %v", first, err)
	}
	second, err := store.SearchPage(context.Background(), "共同范围", Options{Offset: first.NextOffset, Limit: 2, Scopes: filter})
	if err != nil || len(second.Groups) != 1 || second.HasMore {
		t.Fatalf("second scoped page = %#v, %v", second, err)
	}
	seen := make(map[string]struct{}, 3)
	for _, group := range append(first.Groups, second.Groups...) {
		if group.EntryID == "4" || group.EntryID == "5" {
			t.Fatalf("excluded scope crossed a page boundary: %#v", group)
		}
		if _, duplicate := seen[group.EntryID]; duplicate {
			t.Fatalf("duplicate scoped result %q", group.EntryID)
		}
		seen[group.EntryID] = struct{}{}
	}
	if len(seen) != 3 {
		t.Fatalf("scoped results are incomplete: %#v", seen)
	}
	if _, err := store.Search(context.Background(), "共同范围", Options{Limit: 10}); err == nil {
		t.Fatal("zero scope filter was accepted")
	}
}

func TestScopeConstraintAppliesBeforeFTSCandidateLimit(t *testing.T) {
	root := t.TempDir()
	dictionary := filepath.Join(root, "dictionary.db")
	if err := os.WriteFile(dictionary, []byte("primary"), 0600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "reverse.db")
	documents := make([]SearchDocument, 0, defaultCandidates+1)
	for index := 0; index < defaultCandidates; index++ {
		document := doc(fmt.Sprintf("a%05d", index), ScopeExample, fmt.Sprintf("example-%05d", index), "共同词，目标词")
		document.Weight = 1_000_000
		documents = append(documents, document)
	}
	wanted := doc("z-target", ScopePhrase, "target", "共同词，目标词")
	wanted.Weight = -1_000_000
	documents = append(documents, wanted)
	importSidecar(t, dictionary, target, documents, false)
	store, err := Open(target, digest(t, dictionary))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	phraseOnly, err := NewScopeFilter(ScopePhrase)
	if err != nil {
		t.Fatal(err)
	}
	got, err := store.Search(context.Background(), "共同词，目标词", Options{Limit: 5, Scopes: phraseOnly})
	if err != nil || len(got) != 1 || got[0].EntryID != "z-target" {
		t.Fatalf("scope-filtered candidate was lost before LIMIT: %#v, %v", got, err)
	}
}

func TestASCIIConstraintAppliesBeforeFTSCandidateLimit(t *testing.T) {
	root := t.TempDir()
	dictionary := filepath.Join(root, "dictionary.db")
	if err := os.WriteFile(dictionary, []byte("primary"), 0600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "reverse.db")
	documents := make([]SearchDocument, 0, defaultCandidates+1)
	for index := 0; index < defaultCandidates; index++ {
		document := doc(fmt.Sprintf("a%05d", index), ScopeSense, fmt.Sprintf("noise-%05d", index), "共同词，目标词")
		document.Weight = 1_000_000
		documents = append(documents, document)
	}
	wanted := doc("z-target", ScopeSense, "DNA target", "共同词，目标词")
	wanted.Weight = -1_000_000
	documents = append(documents, wanted)
	importSidecar(t, dictionary, target, documents, false)
	store, err := Open(target, digest(t, dictionary))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	got, err := store.Search(context.Background(), "DNA共同词，目标词", allOptions(5))
	if err != nil || len(got) != 1 || got[0].EntryID != "z-target" {
		t.Fatalf("ASCII-filtered candidate was lost before LIMIT: %#v, %v", got, err)
	}
}

func TestMatchAndScopeTiersCannotBeOverriddenByWeights(t *testing.T) {
	root := t.TempDir()
	dictionary := filepath.Join(root, "dictionary.db")
	if err := os.WriteFile(dictionary, []byte("primary"), 0600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "reverse.db")
	documents := []SearchDocument{
		doc("1", ScopeSense, "vocabulary", "词汇"),
		doc("2", ScopeSense, "lexical", "词汇的"),
		doc("3", ScopeSense, "language", "语言中的词汇"),
		doc("4", ScopeSense, "post", "词汇职位"),
		doc("5", ScopeUsage, "usage", "词汇"),
	}
	documents[0].Weight = -1_000_000
	documents[1].Weight = -1_000_000
	for index := 2; index < len(documents); index++ {
		documents[index].Weight = 1_000_000
	}
	importSidecar(t, dictionary, target, documents, false)
	store, err := Open(target, digest(t, dictionary))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	got, err := store.Search(context.Background(), "词汇", allOptions(10))
	if err != nil || len(got) != len(documents) {
		t.Fatalf("tiered ranking = %#v, %v", got, err)
	}
	if got[0].Headword != "vocabulary" || got[1].Headword != "usage" {
		t.Fatalf("exact term/scope tiers were overridden: %#v", got)
	}
	positions := make(map[string]int, len(got))
	for index, group := range got {
		positions[group.Headword] = index
	}
	if positions["lexical"] >= positions["language"] || positions["lexical"] >= positions["post"] {
		t.Fatalf("grammatical extension was overridden by entry weights: %#v", got)
	}
}

func TestTraditionalNormalizationIsReusableAndConcurrent(t *testing.T) {
	const workers = 24
	const iterations = 100
	wanted := "词汇 硅 电脑"
	var wait sync.WaitGroup
	errors := make(chan string, workers)
	for worker := 0; worker < workers; worker++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			for iteration := 0; iteration < iterations; iteration++ {
				if got := normalizeChinese("詞彙，矽，電腦"); got != wanted {
					errors <- got
					return
				}
			}
		}()
	}
	wait.Wait()
	close(errors)
	for got := range errors {
		t.Fatalf("traditional normalization = %q, want %q", got, wanted)
	}
}

func BenchmarkScopedSearch(b *testing.B) {
	root := b.TempDir()
	dictionary := filepath.Join(root, "dictionary.db")
	if err := os.WriteFile(dictionary, []byte("primary"), 0600); err != nil {
		b.Fatal(err)
	}
	target := filepath.Join(root, "reverse.db")
	documents := make([]SearchDocument, 0, 256)
	scopes := []Scope{ScopeSense, ScopePhrase, ScopeForm, ScopeUsage, ScopeExample}
	for index := 0; index < 256; index++ {
		documents = append(documents, doc(fmt.Sprintf("%03d", index), scopes[index%len(scopes)], fmt.Sprintf("entry-%03d", index), "共同基准"))
	}
	importSidecar(b, dictionary, target, documents, false)
	store, err := Open(target, digest(b, dictionary))
	if err != nil {
		b.Fatal(err)
	}
	b.Cleanup(func() { _ = store.Close() })
	options := Options{Limit: 32, Scopes: DefaultScopeFilter()}
	b.ResetTimer()
	for iteration := 0; iteration < b.N; iteration++ {
		if _, err := store.Search(context.Background(), "共同基准", options); err != nil {
			b.Fatal(err)
		}
	}
}

func doc(entryID string, scope Scope, headword, chinese string) SearchDocument {
	weights := map[Scope]int{ScopeSense: 100, ScopePhrase: 100, ScopeUsage: 60, ScopeForm: 60, ScopeExample: 30}
	return SearchDocument{DictionaryID: "oalecd", EntryID: entryID, Scope: scope, Headword: headword, EnglishText: headword + " English", ChineseText: chinese, Location: Location{Section: SectionDefinitions, Path: []string{"sense", entryID}}, Weight: weights[scope]}
}

func allOptions(limit int) Options {
	return Options{Limit: limit, Scopes: AllScopeFilter()}
}

func config(dictionary, target string, source *strings.Reader, replace bool) ImportConfig {
	return ImportConfig{Documents: source, DictionaryPath: dictionary, TargetPath: target, SourceVersion: "source-v1", ProjectionVersion: ProjectionVersion, Replace: replace}
}

func importSidecar(t testing.TB, dictionary, target string, documents []SearchDocument, replace bool) {
	t.Helper()
	if err := Import(context.Background(), config(dictionary, target, strings.NewReader(ndjson(t, documents)), replace)); err != nil {
		t.Fatal(err)
	}
}

func ndjson(t testing.TB, documents []SearchDocument) string {
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

func digest(t testing.TB, path string) string {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	value := sha256.Sum256(content)
	return hex.EncodeToString(value[:])
}

func explainPlan(t *testing.T, db *sql.DB, statement string, arguments ...any) string {
	t.Helper()
	rows, err := db.Query(statement, arguments...)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var details strings.Builder
	for rows.Next() {
		var id, parent, unused int
		var detail string
		if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
			t.Fatal(err)
		}
		if details.Len() > 0 {
			details.WriteString(" | ")
		}
		details.WriteString(detail)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return details.String()
}
