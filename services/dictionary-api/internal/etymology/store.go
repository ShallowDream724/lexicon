package etymology

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"dictionary-api/internal/payload"
	"dictionary-api/internal/termkey"
	"dictionary-api/internal/typo"
	_ "modernc.org/sqlite"
)

type Store struct {
	db            *sql.DB
	sourceVersion string
	codec         payload.Codec
}

type typoCandidate struct {
	term string
	rank int
}

func Open(path string) (*Store, error) {
	if strings.TrimSpace(path) == "" {
		return nil, errors.New("etymology sidecar path is empty")
	}
	db, err := sql.Open("sqlite", sqliteReadOnlyDSN(path))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(4)
	db.SetConnMaxLifetime(0)
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("open etymology sidecar: %w", err)
	}
	store, err := openStore(db)
	if err != nil {
		db.Close()
		return nil, err
	}
	return store, nil
}

func openStore(db *sql.DB) (*Store, error) {
	if err := validateSchema(db); err != nil {
		return nil, err
	}
	sourceVersion, err := metadataText(db, "source_version")
	if err != nil {
		return nil, fmt.Errorf("etymology source version is missing: %w", err)
	}
	if strings.TrimSpace(sourceVersion) == "" {
		return nil, errors.New("etymology source version is empty")
	}
	codecName, err := metadataText(db, "payload_codec")
	if err != nil {
		return nil, fmt.Errorf("etymology payload codec is missing: %w", err)
	}
	dictionary, err := metadataBlob(db, "payload_dictionary")
	if err != nil {
		return nil, fmt.Errorf("etymology payload dictionary is missing: %w", err)
	}
	dictionaryChecksum, err := metadataText(db, "payload_dictionary_sha256")
	if err != nil {
		return nil, fmt.Errorf("etymology payload dictionary checksum is missing: %w", err)
	}
	digest := sha256.Sum256(dictionary)
	if fmt.Sprintf("%x", digest) != dictionaryChecksum {
		return nil, errors.New("etymology payload dictionary checksum is invalid")
	}
	codec, known, err := payload.ByName(codecName, dictionary)
	if err != nil || !known {
		return nil, fmt.Errorf("unsupported etymology payload codec %q: %w", codecName, err)
	}
	return &Store{db: db, sourceVersion: sourceVersion, codec: codec}, nil
}

func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *Store) Available() bool { return s != nil && s.db != nil }

func (s *Store) Summary(ctx context.Context, requestedTerm string) (*ResourceSummary, error) {
	if s == nil {
		return nil, nil
	}
	normalized := termkey.Enhancement(requestedTerm)
	if normalized == "" {
		return nil, nil
	}
	var term, headword string
	err := s.db.QueryRowContext(ctx, `SELECT term, headword FROM etymology_terms WHERE normalized = ?`, normalized).Scan(&term, &headword)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id, label, preview, preview_marks FROM etymology_articles WHERE term_normalized = ? ORDER BY position, id`, normalized)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	articles := make([]ArticleSummary, 0, 2)
	for rows.Next() {
		var article ArticleSummary
		var previewMarks []byte
		if err := rows.Scan(&article.ID, &article.Label, &article.Preview, &previewMarks); err != nil {
			return nil, err
		}
		article.PreviewRuns, err = decodePreviewMarks(article.Preview, previewMarks)
		if err != nil || len(article.PreviewRuns) == 0 {
			return nil, fmt.Errorf("etymology article %q has an invalid preview projection", article.ID)
		}
		if err := validateDocument(Document{Blocks: []Block{{Kind: "paragraph", Runs: article.PreviewRuns}}}); err != nil {
			return nil, fmt.Errorf("etymology article %q has an invalid preview projection: %w", article.ID, err)
		}
		if textFromRuns(article.PreviewRuns) != article.Preview {
			return nil, fmt.Errorf("etymology article %q has an inconsistent preview projection", article.ID)
		}
		articles = append(articles, article)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(articles) == 0 {
		return nil, fmt.Errorf("etymology term %q has no articles", normalized)
	}
	return &ResourceSummary{
		SchemaVersion: SchemaVersion, Kind: Kind, ResourceID: resourceID(normalized), SourceVersion: s.sourceVersion,
		Term: term, Headword: headword, Articles: articles,
	}, nil
}

func (s *Store) Article(ctx context.Context, articleID string) (*ArticleResponse, error) {
	if s == nil || strings.TrimSpace(articleID) == "" {
		return nil, nil
	}
	var normalized, term, headword string
	var compressed, checksum []byte
	var expectedSize int64
	err := s.db.QueryRowContext(ctx, `
		SELECT a.term_normalized, t.term, t.headword, a.payload, a.payload_size, a.payload_sha256
		FROM etymology_articles a
		JOIN etymology_terms t ON t.normalized = a.term_normalized
		WHERE a.id = ?`, articleID).Scan(&normalized, &term, &headword, &compressed, &expectedSize, &checksum)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if expectedSize < 0 || expectedSize > maxArticleSize {
		return nil, fmt.Errorf("article %q has an invalid payload size", articleID)
	}
	raw, err := s.codec.Decompress(compressed, expectedSize)
	digest := sha256.Sum256(raw)
	if err != nil || !bytes.Equal(digest[:], checksum) || !json.Valid(raw) {
		return nil, fmt.Errorf("article %q failed integrity validation", articleID)
	}
	var article Article
	if err := json.Unmarshal(raw, &article); err != nil {
		return nil, fmt.Errorf("decode article %q: %w", articleID, err)
	}
	if article.ID != articleID {
		return nil, fmt.Errorf("article %q has an invalid projection", articleID)
	}
	if err := validateDocument(article.Document); err != nil {
		return nil, fmt.Errorf("article %q has an invalid document: %w", articleID, err)
	}
	return &ArticleResponse{
		SchemaVersion: SchemaVersion, Kind: Kind, ResourceID: resourceID(normalized), SourceVersion: s.sourceVersion,
		Term: term, Headword: headword, Article: article,
	}, nil
}

func (s *Store) Prefix(ctx context.Context, query string, limit int) ([]SearchResult, error) {
	if s == nil || limit < 1 {
		return []SearchResult{}, nil
	}
	canonical := termkey.Enhancement(query)
	if canonical == "" {
		return []SearchResult{}, nil
	}
	prefixEnd := canonical + string(rune(0x10ffff))
	rows, err := s.db.QueryContext(ctx, `
		SELECT normalized, headword
		FROM etymology_terms
		WHERE normalized >= ? AND normalized < ?
		ORDER BY CASE WHEN normalized = ? THEN 0 ELSE 1 END, headword COLLATE NOCASE, normalized
		LIMIT ?`, canonical, prefixEnd, canonical, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	results := make([]SearchResult, 0, limit)
	for rows.Next() {
		var result SearchResult
		if err := rows.Scan(&result.Term, &result.Headword); err != nil {
			return nil, err
		}
		results = append(results, result)
	}
	return results, rows.Err()
}

func (s *Store) Typo(ctx context.Context, query string, limit int) ([]SearchResult, error) {
	canonical := termkey.Enhancement(query)
	if s == nil || !typo.Eligible(canonical) || limit < 1 {
		return []SearchResult{}, nil
	}
	candidates := make(map[string]int, 128)
	directCandidates := typo.DirectCandidates(canonical)
	for rank, candidate := range directCandidates {
		if err := s.collectDirectCandidates(ctx, []string{candidate}, rank, candidates); err != nil {
			return nil, err
		}
	}
	for rank, signature := range typo.SearchSignatures(canonical) {
		if len(candidates) >= 128 {
			break
		}
		rows, err := s.db.QueryContext(ctx, `SELECT term_normalized FROM etymology_term_deletes WHERE signature = ? ORDER BY term_normalized LIMIT ?`, signature, 128-len(candidates))
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var term string
			if err := rows.Scan(&term); err != nil {
				rows.Close()
				return nil, err
			}
			recordCandidate(candidates, term, len(directCandidates)+rank)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}
	}
	return s.loadCandidates(ctx, candidates, limit)
}

func (s *Store) collectDirectCandidates(ctx context.Context, terms []string, rankOffset int, candidates map[string]int) error {
	for index, term := range terms {
		var matched string
		err := s.db.QueryRowContext(ctx, `SELECT normalized FROM etymology_terms WHERE normalized = ?`, term).Scan(&matched)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return err
		}
		recordCandidate(candidates, matched, rankOffset+index)
	}
	return nil
}

func (s *Store) loadCandidates(ctx context.Context, candidates map[string]int, limit int) ([]SearchResult, error) {
	if len(candidates) == 0 {
		return []SearchResult{}, nil
	}
	ordered := make([]typoCandidate, 0, len(candidates))
	for term, rank := range candidates {
		ordered = append(ordered, typoCandidate{term: term, rank: rank})
	}
	sortCandidates(ordered)
	var statement strings.Builder
	statement.WriteString("WITH candidates(term, typo_rank) AS (VALUES ")
	arguments := make([]any, 0, len(ordered)*2+1)
	for index, candidate := range ordered {
		if index > 0 {
			statement.WriteByte(',')
		}
		statement.WriteString("(?, ?)")
		arguments = append(arguments, candidate.term, candidate.rank)
	}
	statement.WriteString(`)
		SELECT t.normalized, t.headword
		FROM candidates c
		JOIN etymology_terms t ON t.normalized = c.term
		ORDER BY c.typo_rank, t.headword COLLATE NOCASE, t.normalized
		LIMIT ?`)
	arguments = append(arguments, limit)
	rows, err := s.db.QueryContext(ctx, statement.String(), arguments...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	results := make([]SearchResult, 0, limit)
	for rows.Next() {
		var result SearchResult
		if err := rows.Scan(&result.Term, &result.Headword); err != nil {
			return nil, err
		}
		results = append(results, result)
	}
	return results, rows.Err()
}

func recordCandidate(candidates map[string]int, term string, rank int) {
	if current, exists := candidates[term]; !exists || rank < current {
		candidates[term] = rank
	}
}

func sortCandidates(candidates []typoCandidate) {
	sort.Slice(candidates, func(left, right int) bool {
		if candidates[left].rank != candidates[right].rank {
			return candidates[left].rank < candidates[right].rank
		}
		return candidates[left].term < candidates[right].term
	})
}

func validateSchema(db *sql.DB) error {
	var version int
	if err := db.QueryRow(`SELECT MAX(version) FROM etymology_schema_migrations`).Scan(&version); err != nil {
		return fmt.Errorf("etymology sidecar schema is missing or unreadable: %w", err)
	}
	if version != SidecarSchemaVersion {
		return fmt.Errorf("unsupported etymology sidecar schema version %d; re-import the etymology source", version)
	}
	return nil
}

func metadataText(db *sql.DB, key string) (string, error) {
	var value string
	err := db.QueryRow(`SELECT value FROM etymology_metadata WHERE key = ?`, key).Scan(&value)
	return value, err
}

func metadataBlob(db *sql.DB, key string) ([]byte, error) {
	var value []byte
	err := db.QueryRow(`SELECT blob_value FROM etymology_metadata WHERE key = ?`, key).Scan(&value)
	return value, err
}
