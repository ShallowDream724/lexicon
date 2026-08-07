package schema

import (
	"database/sql"
	"fmt"
)

const (
	Version          = 3
	versionAppliedAt = "2026-08-06T00:00:00Z"
)

func Apply(db *sql.DB) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	statements := []string{
		`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`,
		`CREATE TABLE dictionary_metadata (key TEXT PRIMARY KEY, value TEXT, blob_value BLOB) WITHOUT ROWID`,
		`CREATE TABLE entries (id TEXT PRIMARY KEY, headword TEXT NOT NULL, parts_of_speech TEXT NOT NULL CHECK(length(parts_of_speech) <= 2048), translation_preview TEXT NOT NULL CHECK(length(translation_preview) <= 120), payload BLOB NOT NULL, payload_size INTEGER NOT NULL CHECK(payload_size >= 0 AND payload_size <= 16777216), payload_sha256 BLOB NOT NULL CHECK(length(payload_sha256) = 32)) WITHOUT ROWID`,
		`CREATE TABLE entry_terms (term TEXT NOT NULL, entry_id TEXT NOT NULL REFERENCES entries(id), PRIMARY KEY (term, entry_id)) WITHOUT ROWID`,
		`CREATE TABLE term_deletes (signature TEXT NOT NULL, term TEXT NOT NULL, PRIMARY KEY (signature, term)) WITHOUT ROWID`,
	}
	for _, statement := range statements {
		if _, err := tx.Exec(statement); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`, Version, versionAppliedAt); err != nil {
		return err
	}
	return tx.Commit()
}

func Validate(db *sql.DB) error {
	var version int
	if err := db.QueryRow(`SELECT MAX(version) FROM schema_migrations`).Scan(&version); err != nil {
		return fmt.Errorf("runtime schema is missing or unreadable: %w", err)
	}
	if version == 1 {
		return fmt.Errorf("runtime schema version 1 is obsolete; rebuild this runtime database by re-importing the source (in-place migration is not supported)")
	}
	if version != Version {
		return fmt.Errorf("unsupported runtime schema version %d; rebuild this runtime database by re-importing the source", version)
	}
	return nil
}

func SourceVersion(db *sql.DB) (string, error) {
	var value string
	if err := db.QueryRow(`SELECT value FROM dictionary_metadata WHERE key = 'source_version'`).Scan(&value); err != nil {
		return "", fmt.Errorf("runtime source version is missing: %w", err)
	}
	return value, nil
}

func PayloadSettings(db *sql.DB) (string, []byte, error) {
	var codec string
	if err := db.QueryRow(`SELECT value FROM dictionary_metadata WHERE key = 'payload_codec'`).Scan(&codec); err != nil {
		return "", nil, fmt.Errorf("runtime payload codec is missing: %w", err)
	}
	var dictionary []byte
	if err := db.QueryRow(`SELECT blob_value FROM dictionary_metadata WHERE key = 'payload_dictionary'`).Scan(&dictionary); err != nil {
		return "", nil, fmt.Errorf("runtime payload dictionary is missing: %w", err)
	}
	return codec, dictionary, nil
}
