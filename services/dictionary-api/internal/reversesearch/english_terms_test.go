package reversesearch

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEnglishTermLookupDistinguishesHeadwordsFormsAndPhrases(t *testing.T) {
	root := t.TempDir()
	dictionary := filepath.Join(root, "dictionary.db")
	if err := os.WriteFile(dictionary, []byte("primary"), 0600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "reverse.db")
	phrase := doc("put", ScopePhrase, "put", "接通电话")
	phrase.CandidateText = "put ˈthrough"
	phrase.Location = Location{Section: SectionPhrasalVerbs, OwnerID: "put-through", Path: []string{"phrasalVerbs", "0", "senses", "0"}}
	pattern := doc("cold-call", ScopeSense, "cold-call", "给陌生人打推销电话")
	pattern.EnglishText = "to phone somebody you do not know"
	pattern.EnglishLookupTerms = []EnglishLookupTerm{{Kind: EnglishTermPattern, Text: "cold-call sb"}}
	pattern.Location = Location{Section: SectionDefinitions, OwnerID: "cold-call-sense", Path: []string{"senses", "0"}}
	think := doc("think", ScopeSense, "think", "想")
	think.HeadwordForms = []string{"thought"}
	thought := doc("thought", ScopeSense, "thought", "想法")
	importSidecar(t, dictionary, target, []SearchDocument{pattern, phrase, think, thought}, false)

	store, err := Open(target, digest(t, dictionary))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	matches, err := store.LookupEnglishTerms(context.Background(), []string{"thought", "put through", "cold-call sb", "missing", "thought"})
	if err != nil {
		t.Fatal(err)
	}
	thoughtMatches := matches["thought"]
	if len(thoughtMatches) != 2 || thoughtMatches[0].Kind != EnglishTermHeadword || thoughtMatches[0].EntryID != "thought" || thoughtMatches[1].Kind != EnglishTermForm || thoughtMatches[1].EntryID != "think" {
		t.Fatalf("thought matches = %#v", thoughtMatches)
	}
	if thoughtMatches[0].Evidence != nil || thoughtMatches[1].Evidence != nil {
		t.Fatalf("headword/form unexpectedly carried contextual evidence: %#v", thoughtMatches)
	}
	phraseMatches := matches["put through"]
	if len(phraseMatches) != 1 || phraseMatches[0].Kind != EnglishTermPhrase || phraseMatches[0].Display != "put ˈthrough" || phraseMatches[0].Evidence == nil || phraseMatches[0].Evidence.CandidateText != "put ˈthrough" || phraseMatches[0].Evidence.ChineseText != "接通电话" || phraseMatches[0].Evidence.Location.OwnerID != "put-through" {
		t.Fatalf("phrase matches = %#v", phraseMatches)
	}
	var display string
	var documentID int
	if err := store.db.QueryRow(`SELECT display, document_id FROM english_terms WHERE term = 'put through'`).Scan(&display, &documentID); err != nil {
		t.Fatal(err)
	}
	if display != "" || documentID == 0 {
		t.Fatalf("phrase index duplicated display evidence: display=%q document_id=%d", display, documentID)
	}
	patternMatches := matches["cold-call sb"]
	if len(patternMatches) != 1 || patternMatches[0].Kind != EnglishTermPattern || patternMatches[0].Headword != "cold-call" || patternMatches[0].Display != "cold-call sb" || patternMatches[0].Evidence == nil || patternMatches[0].Evidence.Scope != ScopeSense || patternMatches[0].Evidence.CandidateText != "cold-call sb" || patternMatches[0].Evidence.DefinitionText != "to phone somebody you do not know" || patternMatches[0].Evidence.ChineseText != "给陌生人打推销电话" {
		rows, queryErr := store.db.Query(`SELECT term, kind, display FROM english_terms WHERE kind = 'pattern' ORDER BY term`)
		if queryErr != nil {
			t.Fatal(queryErr)
		}
		defer rows.Close()
		var stored []string
		for rows.Next() {
			var term, kind, display string
			if err := rows.Scan(&term, &kind, &display); err != nil {
				t.Fatal(err)
			}
			stored = append(stored, term+"|"+kind+"|"+display)
		}
		t.Fatalf("pattern matches = %#v, stored = %#v", patternMatches, stored)
	}
	if len(matches["missing"]) != 0 {
		t.Fatalf("missing term matched: %#v", matches["missing"])
	}
}

func TestEnglishTermLookupRejectsAnUnboundedBatch(t *testing.T) {
	root := t.TempDir()
	dictionary := filepath.Join(root, "dictionary.db")
	if err := os.WriteFile(dictionary, []byte("primary"), 0600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "reverse.db")
	importSidecar(t, dictionary, target, []SearchDocument{doc("one", ScopeSense, "one", "一")}, false)
	store, err := Open(target, digest(t, dictionary))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	terms := make([]string, maxEnglishLookupTerms+1)
	for index := range terms {
		terms[index] = strings.Repeat("a", index/26+1) + string(rune('a'+index%26))
	}
	if _, err := store.LookupEnglishTerms(context.Background(), terms); err == nil {
		t.Fatal("unbounded English lookup was accepted")
	}
}
