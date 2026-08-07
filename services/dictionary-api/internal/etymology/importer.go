package etymology

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"dictionary-api/internal/payload"
	"dictionary-api/internal/termkey"
	"dictionary-api/internal/typo"
	"github.com/klauspost/compress/zstd"
	_ "modernc.org/sqlite"
)

const (
	defaultPageSize         = 8 * 1024
	defaultCompressionLevel = 7
	defaultDictionarySize   = 64 * 1024
	maxArticleSize          = 16 << 20
)

type ImportConfig struct {
	SourcePath    string
	TargetPath    string
	SourceVersion string
	Replace       bool
	Storage       StorageOptions
}

type StorageOptions struct {
	PageSize         int
	CompressionLevel int
	DictionarySize   int
}

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

type importedArticle struct {
	id           string
	word         string
	position     int64
	label        string
	preview      string
	previewMarks []byte
	raw          []byte
}

type importedTerm struct {
	normalized string
	term       string
	headword   string
	articles   []importedArticle
}

// Import creates a project-owned sidecar without copying application source tables.
func Import(ctx context.Context, config ImportConfig) error {
	if strings.TrimSpace(config.SourcePath) == "" || strings.TrimSpace(config.TargetPath) == "" || strings.TrimSpace(config.SourceVersion) == "" {
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
	terms, err := readSource(ctx, source)
	if err != nil {
		return err
	}
	if len(terms) == 0 {
		return errors.New("source database contains no indexed terms")
	}

	temporary, err := os.CreateTemp(filepath.Dir(config.TargetPath), ".etymology-runtime-*.db")
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
	if err := applySchema(destination); err != nil {
		destination.Close()
		return fmt.Errorf("create etymology schema: %w", err)
	}
	dictionary, err := trainDictionary(terms, storage)
	if err != nil {
		destination.Close()
		return err
	}
	codec, err := payload.NewZstdWithLevel(dictionary, storage.CompressionLevel)
	if err != nil {
		destination.Close()
		return err
	}
	if err := writeProjection(ctx, destination, terms, config.SourceVersion, storage, dictionary, codec); err != nil {
		destination.Close()
		return err
	}
	if _, err := destination.ExecContext(ctx, "VACUUM"); err != nil {
		destination.Close()
		return fmt.Errorf("compact etymology sidecar: %w", err)
	}
	if err := destination.Close(); err != nil {
		return err
	}
	if err := replaceAtomically(temporaryPath, config.TargetPath, config.Replace); err != nil {
		return err
	}
	return nil
}

func applySchema(db *sql.DB) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	statements := []string{
		`CREATE TABLE etymology_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`,
		`CREATE TABLE etymology_metadata (key TEXT PRIMARY KEY, value TEXT, blob_value BLOB) WITHOUT ROWID`,
		`CREATE TABLE etymology_terms (normalized TEXT PRIMARY KEY, term TEXT NOT NULL, headword TEXT NOT NULL) WITHOUT ROWID`,
		`CREATE TABLE etymology_articles (id TEXT PRIMARY KEY, term_normalized TEXT NOT NULL REFERENCES etymology_terms(normalized), position INTEGER NOT NULL, label TEXT NOT NULL, preview TEXT NOT NULL CHECK(length(preview) <= 1024), preview_marks BLOB NOT NULL CHECK(length(preview_marks) <= 4096), payload BLOB NOT NULL, payload_size INTEGER NOT NULL CHECK(payload_size >= 0 AND payload_size <= 16777216), payload_sha256 BLOB NOT NULL CHECK(length(payload_sha256) = 32)) WITHOUT ROWID`,
		`CREATE INDEX etymology_articles_by_term ON etymology_articles(term_normalized, position, id)`,
		`CREATE TABLE etymology_term_deletes (signature TEXT NOT NULL, term_normalized TEXT NOT NULL REFERENCES etymology_terms(normalized), PRIMARY KEY (signature, term_normalized)) WITHOUT ROWID`,
		fmt.Sprintf(`INSERT INTO etymology_schema_migrations (version, applied_at) VALUES (%d, datetime('now'))`, SidecarSchemaVersion),
	}
	for _, statement := range statements {
		if _, err := tx.Exec(statement); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func readSource(ctx context.Context, source *sql.DB) ([]importedTerm, error) {
	articles, err := readArticles(ctx, source)
	if err != nil {
		return nil, err
	}
	rows, err := source.QueryContext(ctx, `SELECT CAST(id AS TEXT), word, lowercase, word_ids FROM word_index_etymapp ORDER BY lowercase, id`)
	if err != nil {
		return nil, fmt.Errorf("read term index: %w", err)
	}
	defer rows.Close()
	terms := make([]importedTerm, 0)
	seenTerms := make(map[string]struct{})
	termIndexes := make(map[string]int)
	seenArticles := make(map[string]string)
	for rows.Next() {
		var indexID, word, lowercase, idsJSON sql.NullString
		if err := rows.Scan(&indexID, &word, &lowercase, &idsJSON); err != nil {
			return nil, err
		}
		if !indexID.Valid || !word.Valid || strings.TrimSpace(word.String) == "" || !lowercase.Valid || strings.TrimSpace(lowercase.String) == "" || !idsJSON.Valid {
			return nil, fmt.Errorf("source term index %q is incomplete", indexID.String)
		}
		normalized := termkey.Enhancement(lowercase.String)
		if _, exists := seenTerms[normalized]; exists {
			return nil, fmt.Errorf("source contains duplicate normalized term %q", normalized)
		}
		articleIDs, err := decodeIDs(idsJSON.String)
		if err != nil {
			return nil, fmt.Errorf("source term %q has invalid word_ids: %w", word.String, err)
		}
		if len(articleIDs) == 0 {
			return nil, fmt.Errorf("source term %q has no articles", word.String)
		}
		term := importedTerm{normalized: normalized, term: word.String, headword: word.String, articles: make([]importedArticle, 0, len(articleIDs))}
		for _, articleID := range articleIDs {
			article, exists := articles[articleID]
			if !exists {
				return nil, fmt.Errorf("source term %q references missing article %q", word.String, articleID)
			}
			if priorTerm, used := seenArticles[articleID]; used && priorTerm != normalized {
				return nil, fmt.Errorf("source article %q is assigned to both %q and %q", articleID, priorTerm, normalized)
			}
			seenArticles[articleID] = normalized
			term.articles = append(term.articles, article)
		}
		seenTerms[normalized] = struct{}{}
		terms = append(terms, term)
		termIndexes[normalized] = len(terms) - 1
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	orphans := make([]importedArticle, 0)
	for articleID, article := range articles {
		if _, indexed := seenArticles[articleID]; !indexed {
			orphans = append(orphans, article)
		}
	}
	sort.Slice(orphans, func(left, right int) bool {
		if orphans[left].position != orphans[right].position {
			return orphans[left].position < orphans[right].position
		}
		return orphans[left].id < orphans[right].id
	})
	for _, article := range orphans {
		normalized := termkey.Enhancement(article.word)
		if normalized == "" {
			return nil, fmt.Errorf("unindexed source article %q has no headword", article.id)
		}
		if index, exists := termIndexes[normalized]; exists {
			terms[index].articles = append(terms[index].articles, article)
			continue
		}
		seenTerms[normalized] = struct{}{}
		terms = append(terms, importedTerm{
			normalized: normalized,
			term:       article.word,
			headword:   article.word,
			articles:   []importedArticle{article},
		})
		termIndexes[normalized] = len(terms) - 1
	}
	sort.Slice(terms, func(left, right int) bool { return terms[left].normalized < terms[right].normalized })
	return terms, nil
}

func readArticles(ctx context.Context, source *sql.DB) (map[string]importedArticle, error) {
	rows, err := source.QueryContext(ctx, `SELECT CAST(id AS TEXT), word, sort, etymology, property FROM vocabulary_etymapp ORDER BY id`)
	if err != nil {
		return nil, fmt.Errorf("read articles: %w", err)
	}
	defer rows.Close()
	articles := make(map[string]importedArticle)
	for rows.Next() {
		var id, word, htmlSource, property sql.NullString
		var position sql.NullInt64
		if err := rows.Scan(&id, &word, &position, &htmlSource, &property); err != nil {
			return nil, err
		}
		if !id.Valid || strings.TrimSpace(id.String) == "" || !word.Valid || strings.TrimSpace(word.String) == "" || !htmlSource.Valid {
			return nil, fmt.Errorf("source article %q is incomplete", id.String)
		}
		document, err := ParseHTML(htmlSource.String)
		if err != nil {
			return nil, fmt.Errorf("parse source article %q: %w", id.String, err)
		}
		label := normalizeLabel(property.String)
		previewRuns := PreviewRuns(document)
		article := Article{ID: id.String, Label: label, Preview: textFromRuns(previewRuns), Document: document}
		raw, err := json.Marshal(article)
		if err != nil {
			return nil, err
		}
		if len(raw) > maxArticleSize {
			return nil, fmt.Errorf("source article %q exceeds %d bytes", id.String, maxArticleSize)
		}
		if _, exists := articles[id.String]; exists {
			return nil, fmt.Errorf("source contains duplicate article id %q", id.String)
		}
		previewMarks, err := encodePreviewMarks(previewRuns)
		if err != nil {
			return nil, fmt.Errorf("encode source article %q preview marks: %w", id.String, err)
		}
		articles[id.String] = importedArticle{id: id.String, word: word.String, position: position.Int64, label: label, preview: article.Preview, previewMarks: previewMarks, raw: raw}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return articles, nil
}

func decodeIDs(source string) ([]string, error) {
	decoder := json.NewDecoder(strings.NewReader(source))
	decoder.UseNumber()
	var values []any
	if err := decoder.Decode(&values); err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		var id string
		switch value := value.(type) {
		case string:
			id = value
		case json.Number:
			id = value.String()
		default:
			return nil, fmt.Errorf("article id has unsupported type %T", value)
		}
		id = strings.TrimSpace(id)
		if id == "" {
			return nil, errors.New("article id is empty")
		}
		if _, exists := seen[id]; exists {
			return nil, fmt.Errorf("article id %q is duplicated", id)
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	return ids, nil
}

func writeProjection(ctx context.Context, destination *sql.DB, terms []importedTerm, sourceVersion string, storage StorageOptions, dictionary []byte, codec payload.Codec) error {
	tx, err := destination.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	termStatement, err := tx.PrepareContext(ctx, `INSERT INTO etymology_terms (normalized, term, headword) VALUES (?, ?, ?)`)
	if err != nil {
		return err
	}
	defer termStatement.Close()
	articleStatement, err := tx.PrepareContext(ctx, `INSERT INTO etymology_articles (id, term_normalized, position, label, preview, preview_marks, payload, payload_size, payload_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return err
	}
	defer articleStatement.Close()
	deleteStatement, err := tx.PrepareContext(ctx, `INSERT OR IGNORE INTO etymology_term_deletes (signature, term_normalized) VALUES (?, ?)`)
	if err != nil {
		return err
	}
	defer deleteStatement.Close()
	for _, term := range terms {
		if _, err := termStatement.ExecContext(ctx, term.normalized, term.term, term.headword); err != nil {
			return err
		}
		for _, signature := range typo.DeleteSignatures(term.normalized) {
			if _, err := deleteStatement.ExecContext(ctx, signature, term.normalized); err != nil {
				return err
			}
		}
		for _, article := range term.articles {
			compressed, err := codec.Compress(article.raw)
			if err != nil {
				return fmt.Errorf("compress article %q: %w", article.id, err)
			}
			digest := sha256.Sum256(article.raw)
			if _, err := articleStatement.ExecContext(ctx, article.id, term.normalized, article.position, article.label, article.preview, article.previewMarks, compressed, len(article.raw), digest[:]); err != nil {
				return err
			}
		}
	}
	digest := sha256.Sum256(dictionary)
	metadata := []struct {
		key   string
		value any
		blob  any
	}{
		{"source_version", sourceVersion, nil}, {"payload_codec", codec.Name(), nil}, {"payload_codec_implementation", "github.com/klauspost/compress@v1.18.0", nil},
		{"payload_compression_level", strconv.Itoa(storage.CompressionLevel), nil}, {"payload_dictionary_version", "1", nil},
		{"payload_dictionary_size", strconv.Itoa(len(dictionary)), nil},
		{"payload_dictionary_sha256", fmt.Sprintf("%x", digest), nil}, {"payload_dictionary", nil, dictionary},
	}
	for _, item := range metadata {
		if _, err := tx.ExecContext(ctx, `INSERT INTO etymology_metadata (key, value, blob_value) VALUES (?, ?, ?)`, item.key, item.value, item.blob); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func trainDictionary(terms []importedTerm, storage StorageOptions) ([]byte, error) {
	contents := make([][]byte, 0, 256)
	all := make([][]byte, 0)
	sampleBytes := 0
	for _, term := range terms {
		for _, article := range term.articles {
			all = append(all, article.raw)
		}
	}
	if len(all) == 0 {
		return nil, errors.New("source database contains no articles")
	}
	stride := (len(all) + 255) / 256
	history := make([]byte, 0, storage.DictionarySize)
	for index, raw := range all {
		if index%stride != 0 {
			continue
		}
		sample := raw
		if len(sample) > 32*1024 {
			sample = sample[:32*1024]
		}
		contents = append(contents, sample)
		sampleBytes += len(sample)
		if remaining := storage.DictionarySize - len(history); remaining > 0 {
			if len(sample) > remaining {
				sample = sample[:remaining]
			}
			history = append(history, sample...)
		}
	}
	if len(history) == 0 {
		return nil, errors.New("source database has no article content")
	}
	if len(contents) < 8 || sampleBytes < storage.DictionarySize {
		return nil, nil
	}
	for len(history) < storage.DictionarySize {
		history = append(history, history...)
	}
	history = history[:storage.DictionarySize]
	dictionary, err := buildDictionary(zstd.BuildDictOptions{ID: 1, Contents: contents, History: history, Offsets: [3]int{1, 4, 8}, Level: zstd.EncoderLevelFromZstd(storage.CompressionLevel)})
	if err != nil {
		return nil, err
	}
	return dictionary, nil
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

func normalizeLabel(value string) string {
	value = strings.TrimSpace(value)
	if len(value) >= 2 && value[0] == '(' && value[len(value)-1] == ')' {
		return value[1 : len(value)-1]
	}
	return value
}

func sqliteReadOnlyDSN(path string) string { return "file:" + filepath.ToSlash(path) + "?mode=ro" }
