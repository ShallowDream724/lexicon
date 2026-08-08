package runtimeentry

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"reflect"
	"testing"

	_ "modernc.org/sqlite"
)

type identityCodec struct{}

func (identityCodec) Name() string                                     { return "identity" }
func (identityCodec) Compress(input []byte) ([]byte, error)            { return input, nil }
func (identityCodec) Decompress(input []byte, _ int64) ([]byte, error) { return input, nil }

func TestReaderGetAndWalkShareIntegrityChecks(t *testing.T) {
	db := fixtureDatabase(t)
	reader := NewReader(db, identityCodec{}, "fixture-v1")

	envelope, err := reader.Get(context.Background(), "b")
	if err != nil {
		t.Fatal(err)
	}
	if envelope.EntryID != "b" || envelope.Headword != "beta" || envelope.SourceVersion != "fixture-v1" || string(envelope.Body) != `{"value":2}` {
		t.Fatalf("unexpected envelope: %#v", envelope)
	}

	var ids []string
	err = reader.Walk(context.Background(), func(item Envelope) error {
		ids = append(ids, item.EntryID)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(ids, []string{"a", "b"}) {
		t.Fatalf("walk order = %#v", ids)
	}
}

func TestReaderRejectsMissingAndCorruptEntries(t *testing.T) {
	db := fixtureDatabase(t)
	reader := NewReader(db, identityCodec{}, "fixture-v1")
	if _, err := reader.Get(context.Background(), "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing error = %v", err)
	}
	if _, err := db.Exec(`UPDATE entries SET payload_sha256 = zeroblob(32) WHERE id = 'a'`); err != nil {
		t.Fatal(err)
	}
	if _, err := reader.Get(context.Background(), "a"); !errors.Is(err, ErrInvalidPayload) {
		t.Fatalf("corrupt error = %v", err)
	}
}

func fixtureDatabase(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+t.TempDir()+"/runtime.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	if _, err := db.Exec(`CREATE TABLE entries (
		id TEXT PRIMARY KEY,
		headword TEXT NOT NULL,
		payload BLOB NOT NULL,
		payload_size INTEGER NOT NULL,
		payload_sha256 BLOB NOT NULL
	)`); err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct{ id, headword, body string }{
		{"b", "beta", `{"value":2}`},
		{"a", "alpha", `{"value":1}`},
	} {
		digest := sha256.Sum256([]byte(item.body))
		if _, err := db.Exec(
			`INSERT INTO entries (id, headword, payload, payload_size, payload_sha256) VALUES (?, ?, ?, ?, ?)`,
			item.id, item.headword, []byte(item.body), len(item.body), digest[:],
		); err != nil {
			t.Fatal(err)
		}
	}
	return db
}
