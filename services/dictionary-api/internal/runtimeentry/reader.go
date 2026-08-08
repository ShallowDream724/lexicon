package runtimeentry

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"dictionary-api/internal/payload"
)

const MaxPayloadSize = 16 << 20

var (
	ErrNotFound       = errors.New("runtime entry was not found")
	ErrInvalidPayload = errors.New("runtime entry payload is invalid")
)

type Envelope struct {
	EntryID       string          `json:"entryId"`
	Headword      string          `json:"headword"`
	SourceVersion string          `json:"sourceVersion"`
	Body          json.RawMessage `json:"body"`
}

type Reader struct {
	db            *sql.DB
	codec         payload.Codec
	sourceVersion string
}

func NewReader(db *sql.DB, codec payload.Codec, sourceVersion string) *Reader {
	return &Reader{db: db, codec: codec, sourceVersion: sourceVersion}
}

func (reader *Reader) Get(ctx context.Context, id string) (Envelope, error) {
	var headword string
	var compressed, checksum []byte
	var size int64
	err := reader.db.QueryRowContext(ctx, `
		SELECT headword, payload, payload_size, payload_sha256
		FROM entries
		WHERE id = ?`, id).Scan(&headword, &compressed, &size, &checksum)
	if errors.Is(err, sql.ErrNoRows) {
		return Envelope{}, ErrNotFound
	}
	if err != nil {
		return Envelope{}, err
	}
	return reader.decode(id, headword, compressed, size, checksum)
}

func (reader *Reader) Walk(ctx context.Context, visit func(Envelope) error) error {
	rows, err := reader.db.QueryContext(ctx, `
		SELECT id, headword, payload, payload_size, payload_sha256
		FROM entries
		ORDER BY id`)
	if err != nil {
		return err
	}
	defer rows.Close()

	for rows.Next() {
		var id, headword string
		var compressed, checksum []byte
		var size int64
		if err := rows.Scan(&id, &headword, &compressed, &size, &checksum); err != nil {
			return err
		}
		envelope, err := reader.decode(id, headword, compressed, size, checksum)
		if err != nil {
			return err
		}
		if err := visit(envelope); err != nil {
			return err
		}
	}
	return rows.Err()
}

func (reader *Reader) decode(
	id string,
	headword string,
	compressed []byte,
	size int64,
	checksum []byte,
) (Envelope, error) {
	if reader.codec == nil || size < 0 || size > MaxPayloadSize || len(checksum) != sha256.Size {
		return Envelope{}, fmt.Errorf("%w: entry %q has invalid metadata", ErrInvalidPayload, id)
	}
	raw, err := reader.codec.Decompress(compressed, size)
	if err != nil {
		return Envelope{}, fmt.Errorf("%w: decode entry %q: %v", ErrInvalidPayload, id, err)
	}
	digest := sha256.Sum256(raw)
	if !bytes.Equal(digest[:], checksum) || !json.Valid(raw) {
		return Envelope{}, fmt.Errorf("%w: entry %q failed integrity validation", ErrInvalidPayload, id)
	}
	return Envelope{
		EntryID:       id,
		Headword:      headword,
		SourceVersion: reader.sourceVersion,
		Body:          json.RawMessage(raw),
	}, nil
}
