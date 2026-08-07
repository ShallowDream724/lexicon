package importer

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"

	"dictionary-api/internal/payload"
	"dictionary-api/internal/schema"
	"dictionary-api/internal/termkey"
	"dictionary-api/internal/typo"
	"github.com/klauspost/compress/zstd"
	_ "modernc.org/sqlite"
)

type Config struct {
	SourcePath    string
	TargetPath    string
	SourceVersion string
	Replace       bool
	Storage       StorageOptions
}

// StorageOptions controls physical layout for a newly generated runtime database.
// Zero values select the recommended production layout.
type StorageOptions struct {
	PageSize         int
	CompressionLevel int
	DictionarySize   int
}

const (
	defaultPageSize         = 8 * 1024
	defaultCompressionLevel = 7
	defaultDictionarySize   = 64 * 1024
)

func (options StorageOptions) normalized() (StorageOptions, error) {
	if options.PageSize == 0 {
		options.PageSize = defaultPageSize
	}
	if options.CompressionLevel == 0 {
		options.CompressionLevel = defaultCompressionLevel
	}
	if options.DictionarySize == 0 {
		options.DictionarySize = defaultDictionarySize
	}
	if options.PageSize < 512 || options.PageSize > 65536 || options.PageSize&(options.PageSize-1) != 0 {
		return StorageOptions{}, fmt.Errorf("SQLite page size %d must be a power of two from 512 through 65536", options.PageSize)
	}
	if options.CompressionLevel < 1 || options.CompressionLevel > 22 {
		return StorageOptions{}, fmt.Errorf("zstd compression level %d must be in 1..22", options.CompressionLevel)
	}
	if options.DictionarySize < 1024 || options.DictionarySize > 128*1024 {
		return StorageOptions{}, fmt.Errorf("dictionary size %d must be in 1024..131072", options.DictionarySize)
	}
	return options, nil
}

// Import creates a standalone runtime database. The supplied source database
// is opened read-only and is never changed.
func Import(ctx context.Context, config Config) error {
	if config.SourcePath == "" || config.TargetPath == "" || config.SourceVersion == "" {
		return errors.New("source path, target path, and source version are required")
	}
	if _, err := os.Stat(config.TargetPath); err == nil && !config.Replace {
		return fmt.Errorf("target database already exists: %s (use -replace to overwrite)", config.TargetPath)
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	storage, err := config.Storage.normalized()
	if err != nil {
		return err
	}

	source, err := sql.Open("sqlite", sqliteReadOnlyDSN(config.SourcePath))
	if err != nil {
		return err
	}
	defer source.Close()
	if err := source.PingContext(ctx); err != nil {
		return fmt.Errorf("open source database: %w", err)
	}

	temporary, err := os.CreateTemp(filepath.Dir(config.TargetPath), ".dictionary-runtime-*.db")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Remove(temporaryPath); err != nil {
		return err
	}
	defer os.Remove(temporaryPath)

	destination, err := sql.Open("sqlite", temporaryPath)
	if err != nil {
		return err
	}
	if _, err := destination.ExecContext(ctx, "PRAGMA page_size = "+strconv.Itoa(storage.PageSize)); err != nil {
		destination.Close()
		return fmt.Errorf("set SQLite page size: %w", err)
	}
	if err := schema.Apply(destination); err != nil {
		destination.Close()
		return fmt.Errorf("create runtime schema: %w", err)
	}
	dictionary, err := trainDictionary(ctx, source, storage)
	if err != nil {
		destination.Close()
		return err
	}
	codec, err := payload.NewZstdWithLevel(dictionary, storage.CompressionLevel)
	if err != nil {
		destination.Close()
		return err
	}
	if err := copyEntries(ctx, source, destination, config.SourceVersion, codec, dictionary, storage); err != nil {
		destination.Close()
		return err
	}
	if _, err := destination.ExecContext(ctx, "VACUUM"); err != nil {
		destination.Close()
		return fmt.Errorf("compact runtime database: %w", err)
	}
	if err := destination.Close(); err != nil {
		return err
	}

	if config.Replace {
		if err := os.Remove(config.TargetPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return os.Rename(temporaryPath, config.TargetPath)
}

func copyEntries(ctx context.Context, source, destination *sql.DB, sourceVersion string, codec payload.Codec, dictionary []byte, storage StorageOptions) error {
	rows, err := source.QueryContext(ctx, `SELECT id, word, word_body, word_search FROM oxford_x_word ORDER BY id`)
	if err != nil {
		return fmt.Errorf("read source entries: %w", err)
	}
	defer rows.Close()
	tx, err := destination.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	entryStatement, err := tx.PrepareContext(ctx, `INSERT INTO entries (id, headword, parts_of_speech, translation_preview, payload, payload_size, payload_sha256) VALUES (?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return err
	}
	defer entryStatement.Close()
	termStatement, err := tx.PrepareContext(ctx, `INSERT INTO entry_terms (term, entry_id) VALUES (?, ?)`)
	if err != nil {
		return err
	}
	defer termStatement.Close()
	deleteStatement, err := tx.PrepareContext(ctx, `INSERT OR IGNORE INTO term_deletes (signature, term) VALUES (?, ?)`)
	if err != nil {
		return err
	}
	defer deleteStatement.Close()
	for rows.Next() {
		var id, headword, body, sourceTerm sql.NullString
		if err := rows.Scan(&id, &headword, &body, &sourceTerm); err != nil {
			return err
		}
		if !id.Valid || !headword.Valid || !body.Valid || !json.Valid([]byte(body.String)) {
			return fmt.Errorf("source entry %q is incomplete or has invalid JSON", id.String)
		}
		raw := []byte(body.String)
		projection, err := extractSearchProjection(raw)
		if err != nil {
			return fmt.Errorf("extract search projection for source entry %q: %w", id.String, err)
		}
		partsOfSpeech, err := json.Marshal(projection.PartsOfSpeech)
		if err != nil {
			return fmt.Errorf("encode search projection for source entry %q: %w", id.String, err)
		}
		compressed, err := codec.Compress(raw)
		if err != nil {
			return fmt.Errorf("compress source entry %q: %w", id.String, err)
		}
		checksum := sha256.Sum256(raw)
		if _, err := entryStatement.ExecContext(ctx, id.String, headword.String, string(partsOfSpeech), projection.TranslationPreview, compressed, len(raw), checksum[:]); err != nil {
			return err
		}
		terms := map[string]struct{}{termkey.Dictionary(headword.String): {}}
		if sourceTerm.Valid {
			terms[termkey.Dictionary(sourceTerm.String)] = struct{}{}
		}
		for term := range terms {
			if term != "" {
				if _, err := termStatement.ExecContext(ctx, term, id.String); err != nil {
					return err
				}
				for _, signature := range typo.DeleteSignatures(term) {
					if _, err := deleteStatement.ExecContext(ctx, signature, term); err != nil {
						return err
					}
				}
			}
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	digest := sha256.Sum256(dictionary)
	metadata := []struct {
		key   string
		value any
		blob  any
	}{
		{"source_version", sourceVersion, nil}, {"payload_codec", codec.Name(), nil}, {"payload_codec_implementation", payload.Implementation, nil},
		{"payload_compression_level", strconv.Itoa(storage.CompressionLevel), nil}, {"payload_dictionary_version", "1", nil},
		{"payload_dictionary_size", strconv.Itoa(storage.DictionarySize), nil},
		{"payload_dictionary_sha256", fmt.Sprintf("%x", digest), nil}, {"payload_dictionary", nil, dictionary},
	}
	for _, item := range metadata {
		if _, err := tx.ExecContext(ctx, `INSERT INTO dictionary_metadata (key, value, blob_value) VALUES (?, ?, ?)`, item.key, item.value, item.blob); err != nil {
			return err
		}
	}
	return tx.Commit()
}

const trainingSampleCount = 256
const trainingSampleBytes = 32 * 1024

func trainDictionary(ctx context.Context, source *sql.DB, storage StorageOptions) ([]byte, error) {
	var count int
	if err := source.QueryRowContext(ctx, `SELECT COUNT(*) FROM oxford_x_word`).Scan(&count); err != nil {
		return nil, err
	}
	if count == 0 {
		return nil, errors.New("source database contains no entries")
	}
	stride := (count + trainingSampleCount - 1) / trainingSampleCount
	rows, err := source.QueryContext(ctx, `SELECT word_body FROM oxford_x_word ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	contents := make([][]byte, 0, trainingSampleCount)
	history := make([]byte, 0, storage.DictionarySize)
	for index := 0; rows.Next(); index++ {
		var body string
		if err := rows.Scan(&body); err != nil {
			return nil, err
		}
		if index%stride != 0 {
			continue
		}
		sample := []byte(body)
		if len(sample) > trainingSampleBytes {
			sample = sample[:trainingSampleBytes]
		}
		contents = append(contents, sample)
		if len(history) < storage.DictionarySize {
			needed := storage.DictionarySize - len(history)
			if len(sample) > needed {
				sample = sample[:needed]
			}
			history = append(history, sample...)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(history) == 0 {
		return nil, errors.New("source database has no body content")
	}
	for len(history) < storage.DictionarySize {
		history = append(history, history...)
	}
	history = history[:storage.DictionarySize]
	return buildDictionary(zstd.BuildDictOptions{ID: 1, Contents: contents, History: history, Offsets: [3]int{1, 4, 8}, Level: zstd.EncoderLevelFromZstd(storage.CompressionLevel)})
}

func buildDictionary(options zstd.BuildDictOptions) (dictionary []byte, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			dictionary = nil
			err = fmt.Errorf("zstd dictionary training failed: %v", recovered)
		}
	}()
	return zstd.BuildDict(options)
}

func sqliteReadOnlyDSN(path string) string { return "file:" + filepath.ToSlash(path) + "?mode=ro" }
