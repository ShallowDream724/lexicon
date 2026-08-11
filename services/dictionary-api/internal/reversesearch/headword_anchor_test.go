package reversesearch

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestImportStoresHeadwordTermsSeparatelyFromForms(t *testing.T) {
	root := t.TempDir()
	dictionary := filepath.Join(root, "dictionary.db")
	if err := os.WriteFile(dictionary, []byte("primary"), 0600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "reverse.db")
	phrase := doc("phrase", ScopePhrase, "On No Account", "绝对不可以")
	phrase.HeadwordForms = []string{"  on-no-account  ", "On No Account"}
	wiFi := doc("wifi", ScopeSense, "Wi-Fi", "无线网络")
	importSidecar(t, dictionary, target, []SearchDocument{phrase, wiFi}, false)

	db, err := sql.Open("sqlite", target)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var tableSQL string
	if err := db.QueryRow(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'entry_headword_terms'`).Scan(&tableSQL); err != nil || !strings.Contains(tableSQL, "PRIMARY KEY(term, entry_id)") || !strings.Contains(tableSQL, "WITHOUT ROWID") {
		t.Fatalf("headword-term table schema = %q, %v", tableSQL, err)
	}
	var terms []string
	rows, err := db.Query(`SELECT term FROM entry_headword_terms ORDER BY term`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var term string
		if err := rows.Scan(&term); err != nil {
			t.Fatal(err)
		}
		terms = append(terms, term)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if got, want := strings.Join(terms, ","), "on no account,on-no-account,wi-fi"; got != want {
		t.Fatalf("headword terms = %q, want %q", got, want)
	}
	var count string
	if err := db.QueryRow(`SELECT value FROM metadata WHERE key = 'headword_term_count'`).Scan(&count); err != nil || count != "3" {
		t.Fatalf("headword_term_count = %q, %v", count, err)
	}
	plan := explainPlan(t, db, `
		EXPLAIN QUERY PLAN
		WITH query_terms(term, ordinal) AS (VALUES (?, ?)), anchor_entries AS (
			SELECT h.entry_id, MIN(q.ordinal) AS anchor_rank
			FROM query_terms q
			JOIN entry_headword_terms h ON h.term = q.term
			GROUP BY h.entry_id
			ORDER BY anchor_rank, h.entry_id
			LIMIT ?
		)
		SELECT d.id FROM anchor_entries a JOIN documents d ON d.entry_id = a.entry_id
		WHERE d.scope IN (?) ORDER BY a.anchor_rank, d.weight DESC, d.entry_id, d.id LIMIT ?`, "wi-fi", 0, defaultCandidates, ScopeSense, defaultCandidates)
	if !strings.Contains(plan, "SEARCH h USING PRIMARY KEY (term=?)") || !strings.Contains(plan, "SEARCH d USING INDEX documents_by_entry_scope") {
		t.Fatalf("unexpected headword-anchor query plan: %s", plan)
	}
}

func TestHeadwordAnchorsRecallMixedQueriesWithoutFakingChineseEvidence(t *testing.T) {
	root := t.TempDir()
	dictionary := filepath.Join(root, "dictionary.db")
	if err := os.WriteFile(dictionary, []byte("primary"), 0600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "reverse.db")
	help := doc("help", ScopeSense, "help", "协助他人")
	helper := doc("helper", ScopeSense, "helper", "后面到底带不带的说明")
	helper.EnglishText = "helper to English"
	plz := doc("plz", ScopeSense, "plz", "短信缩写")
	onNoAccount := doc("on-no-account", ScopePhrase, "on no account", "绝对不可以")
	account := doc("account", ScopeResource, "account", "账目记录")
	account.ResourceCategory = ResourceNote
	on := doc("on", ScopeSense, "on", "在上面")
	help.SemanticRole = SemanticRoleGuidance
	help.Origin = OriginUse
	plz.SemanticRole = SemanticRoleGuidance
	plz.Origin = OriginUse
	importSidecar(t, dictionary, target, []SearchDocument{account, help, helper, on, onNoAccount, plz}, false)
	store, err := Open(target, digest(t, dictionary))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	assertAnchoredEntry := func(query, wanted string) {
		t.Helper()
		groups, err := store.Search(context.Background(), query, allOptions(10))
		if err != nil {
			t.Fatal(err)
		}
		for _, group := range groups {
			if group.EntryID == wanted {
				if !group.HeadwordAnchor {
					t.Fatalf("query %q returned %q without anchor signal: %#v", query, wanted, group)
				}
				return
			}
		}
		t.Fatalf("query %q did not return anchored entry %q: %#v", query, wanted, groups)
	}
	assertAnchoredEntry("help 后面到底带不带 to？", "help")
	assertAnchoredEntry("正式邮件里写 plz 可以吗？", "plz")
	assertAnchoredEntry("on 是什么意思", "on")
	meaningOnly, err := NewScopeFilter(ScopeSense)
	if err != nil {
		t.Fatal(err)
	}
	meaningGroups, err := store.Search(context.Background(), "正式邮件里写 plz 可以吗？", Options{Limit: 10, Scopes: meaningOnly})
	if err != nil || len(meaningGroups) != 1 || meaningGroups[0].EntryID != "plz" || !meaningGroups[0].HeadwordAnchor {
		t.Fatalf("meaning-only anchor = %#v, %v", meaningGroups, err)
	}

	groups, err := store.Search(context.Background(), "help 后面到底带不带 to？", allOptions(10))
	if err != nil {
		t.Fatal(err)
	}
	if containsGroup(groups, "helper") {
		t.Fatalf("token-prefix match returned helper for help: %#v", groups)
	}
	groups, err = store.Search(context.Background(), "on no account 是不是就是绝对不能的意思？", allOptions(10))
	if err != nil || len(groups) < 2 || !containsGroup(groups, "account") {
		t.Fatalf("function words displaced meaningful account anchor: %#v, %v", groups, err)
	}
	for _, group := range groups {
		if group.EntryID == "on-no-account" && group.HeadwordAnchorRank != 0 {
			t.Fatalf("phrase anchor rank = %d, want 0", group.HeadwordAnchorRank)
		}
	}
	for _, group := range groups {
		if group.EntryID == "on-no-account" && group.Relevance.Tier >= 2 {
			t.Fatalf("anchor promoted Chinese evidence tier: %#v", group)
		}
	}
}

func TestHeadwordAnchorOrdersApplicableUsageEvidenceByExactQueryTerms(t *testing.T) {
	root := t.TempDir()
	dictionary := filepath.Join(root, "dictionary.db")
	if err := os.WriteFile(dictionary, []byte("primary"), 0600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "reverse.db")
	direct := doc("afraid", ScopeResource, "afraid", "关于名词前位置和介词选择的规则")
	direct.EnglishText = "afraid to do something"
	direct.CandidateText = "afraid to do something"
	direct.SemanticRole = SemanticRoleExpression
	direct.Origin = OriginGrammarUsageBox
	direct.ResourceCategory = ResourceGrammar
	guidance := doc("afraid", ScopeResource, "afraid", "关于名词前位置和介词选择的规则")
	guidance.EnglishText = "Afraid cannot come before a noun and takes of, not about."
	guidance.SemanticRole = SemanticRoleGuidance
	guidance.Origin = OriginGrammarUsageBox
	guidance.ResourceCategory = ResourceGrammar
	importSidecar(t, dictionary, target, []SearchDocument{direct, guidance}, false)
	store, err := Open(target, digest(t, dictionary))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	resourceOnly, _ := NewScopeFilter(ScopeResource)
	groups, err := store.Search(context.Background(), "afraid 能放名词前/of还是about", Options{Limit: 10, Scopes: resourceOnly})
	if err != nil || len(groups) != 1 || len(groups[0].Matches) != 2 {
		t.Fatalf("usage evidence = %#v, %v", groups, err)
	}
	if groups[0].Matches[0].English != guidance.EnglishText {
		t.Fatalf("applicable guidance was buried: %#v", groups[0].Matches)
	}
}

func TestHeadwordAnchorsRespectScopeAndCancellation(t *testing.T) {
	root := t.TempDir()
	dictionary := filepath.Join(root, "dictionary.db")
	if err := os.WriteFile(dictionary, []byte("primary"), 0600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "reverse.db")
	example := doc("help", ScopeExample, "help", "协助说明")
	importSidecar(t, dictionary, target, []SearchDocument{example}, false)
	store, err := Open(target, digest(t, dictionary))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	if groups, err := store.Search(context.Background(), "help 是什么意思", Options{Limit: 10, Scopes: DefaultScopeFilter()}); err != nil || len(groups) != 0 {
		t.Fatalf("out-of-scope anchor was returned: %#v, %v", groups, err)
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := store.Search(cancelled, "help 是什么意思", allOptions(10)); err == nil {
		t.Fatal("cancelled anchor query succeeded")
	}
}

func TestHeadwordAnchorAppliesScopeBeforeTheEntryLimit(t *testing.T) {
	root := t.TempDir()
	dictionary := filepath.Join(root, "dictionary.db")
	if err := os.WriteFile(dictionary, []byte("primary"), 0600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "reverse.db")
	documents := make([]SearchDocument, 0, defaultCandidates+1)
	for index := 0; index < defaultCandidates; index++ {
		documents = append(documents, doc(fmt.Sprintf("sense-%05d", index), ScopeSense, "x", "普通词义"))
	}
	resource := doc("z-resource-target", ScopeResource, "x", "用法规则")
	resource.ResourceCategory = ResourceGrammar
	documents = append(documents, resource)
	importSidecar(t, dictionary, target, documents, false)
	store, err := Open(target, digest(t, dictionary))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	resourceOnly, _ := NewScopeFilter(ScopeResource)
	groups, err := store.Search(context.Background(), "x 怎么用", Options{Limit: 10, Scopes: resourceOnly})
	if err != nil || len(groups) != 1 || groups[0].EntryID != "z-resource-target" || !groups[0].HeadwordAnchor {
		t.Fatalf("scope-filtered anchor = %#v, %v", groups, err)
	}
}

func containsGroup(groups []Group, entryID string) bool {
	for _, group := range groups {
		if group.EntryID == entryID {
			return true
		}
	}
	return false
}
