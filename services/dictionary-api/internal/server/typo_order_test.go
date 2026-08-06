package server

import (
	"context"
	"database/sql"
	"fmt"
	"testing"

	_ "modernc.org/sqlite"
)

func TestTypoCandidateCapKeepsDisplayOrder(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	if _, err := db.Exec(`
		CREATE TABLE entries (
			id TEXT PRIMARY KEY,
			headword TEXT NOT NULL,
			parts_of_speech TEXT NOT NULL,
			translation_preview TEXT NOT NULL
		) WITHOUT ROWID;
		CREATE TABLE entry_terms (
			term TEXT NOT NULL,
			entry_id TEXT NOT NULL,
			PRIMARY KEY (term, entry_id)
		) WITHOUT ROWID;
		CREATE TABLE term_deletes (
			signature TEXT NOT NULL,
			term TEXT NOT NULL,
			PRIMARY KEY (signature, term)
		) WITHOUT ROWID;
	`); err != nil {
		t.Fatal(err)
	}

	for index := 0; index < 130; index++ {
		entryID := fmt.Sprintf("entry-%03d", 129-index)
		headword := fmt.Sprintf("cat %03d", index)
		if _, err := db.Exec(
			`INSERT INTO entries (id, headword, parts_of_speech, translation_preview) VALUES (?, ?, '[]', '')`,
			entryID,
			headword,
		); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`INSERT INTO entry_terms (term, entry_id) VALUES ('cat', ?)`, entryID); err != nil {
			t.Fatal(err)
		}
	}

	service := &Service{db: db}
	results, err := service.queryTypoSuggestions(context.Background(), "cta", 5)
	if err != nil {
		t.Fatal(err)
	}
	for index, result := range results {
		want := fmt.Sprintf("cat %03d", index)
		if result.Headword != want {
			t.Fatalf("result %d = %q, want %q", index, result.Headword, want)
		}
	}
}
