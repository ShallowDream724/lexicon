package schema

import (
	"database/sql"
	"path/filepath"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

func TestValidateRejectsSchemaV1WithReimportGuidance(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "runtime-v1.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); INSERT INTO schema_migrations (version, applied_at) VALUES (1, datetime('now'))`); err != nil {
		t.Fatal(err)
	}

	err = Validate(db)
	if err == nil || !strings.Contains(err.Error(), "version 1 is obsolete") || !strings.Contains(err.Error(), "re-importing the source") {
		t.Fatalf("Validate() error = %v, want re-import guidance", err)
	}
}

func TestApplyRecordsDeterministicSchemaVersion(t *testing.T) {
	db, err := sql.Open("sqlite", filepath.Join(t.TempDir(), "runtime.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := Apply(db); err != nil {
		t.Fatal(err)
	}
	var version int
	var appliedAt string
	if err := db.QueryRow(`SELECT version, applied_at FROM schema_migrations`).Scan(&version, &appliedAt); err != nil {
		t.Fatal(err)
	}
	if version != Version || appliedAt != versionAppliedAt {
		t.Fatalf("schema marker = (%d, %q), want (%d, %q)", version, appliedAt, Version, versionAppliedAt)
	}
}
