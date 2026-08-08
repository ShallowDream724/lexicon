package reversesearch

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"path/filepath"
	"sort"
	"strings"

	_ "modernc.org/sqlite"
)

type Store struct{ db *sql.DB }

type candidate struct {
	document SearchDocument
	bm25     float64
	score    float64
	exact    bool
	coverage float64
	longest  int
}

// Open validates that the sidecar was built from the current primary dictionary.
func Open(path, expectedPrimarySHA256 string) (*Store, error) {
	if strings.TrimSpace(path) == "" || strings.TrimSpace(expectedPrimarySHA256) == "" {
		return nil, errors.New("sidecar path and expected primary SHA-256 are required")
	}
	db, err := sql.Open("sqlite", sqliteReadOnlyDSN(path))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(4)
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("open reverse-search sidecar: %w", err)
	}
	if err := validateStore(db, expectedPrimarySHA256); err != nil {
		db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}

func sqliteReadOnlyDSN(path string) string { return "file:" + filepath.ToSlash(path) + "?mode=ro" }

func validateStore(db *sql.DB, expectedPrimarySHA256 string) error {
	expected := map[string]string{
		"schema_version": strconvSchemaVersion(), "normalizer_version": NormalizerVersion,
		"primary_sha256": expectedPrimarySHA256, "projection_version": ProjectionVersion,
	}
	for key, wanted := range expected {
		var actual string
		if err := db.QueryRow(`SELECT value FROM metadata WHERE key = ?`, key).Scan(&actual); err != nil {
			return fmt.Errorf("reverse-search metadata %q is missing: %w", key, err)
		}
		if actual != wanted {
			return fmt.Errorf("reverse-search metadata %q does not match", key)
		}
	}
	for _, key := range []string{"source_version", "document_count"} {
		var value string
		if err := db.QueryRow(`SELECT value FROM metadata WHERE key = ?`, key).Scan(&value); err != nil || strings.TrimSpace(value) == "" {
			return fmt.Errorf("reverse-search metadata %q is missing or empty", key)
		}
	}
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM documents`).Scan(&count); err != nil || count < 1 {
		return errors.New("reverse-search documents table is missing or empty")
	}
	var storedCount string
	if err := db.QueryRow(`SELECT value FROM metadata WHERE key = 'document_count'`).Scan(&storedCount); err != nil || storedCount != fmt.Sprintf("%d", count) {
		return errors.New("reverse-search document count metadata is invalid")
	}
	var indexedCount int
	if err := db.QueryRow(`SELECT COUNT(*) FROM documents_fts`).Scan(&indexedCount); err != nil || indexedCount != count {
		return errors.New("reverse-search full-text index is missing or incomplete")
	}
	return nil
}

func strconvSchemaVersion() string { return fmt.Sprintf("%d", SchemaVersion) }

func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *Store) Available() bool { return s != nil && s.db != nil }

func (s *Store) Search(ctx context.Context, query string, limit int) ([]Group, error) {
	if s == nil || s.db == nil || limit < 1 {
		return []Group{}, nil
	}
	if len([]rune(query)) > maxQueryRunes {
		return nil, fmt.Errorf("reverse-search query exceeds %d characters", maxQueryRunes)
	}
	if limit > maxResults {
		limit = maxResults
	}
	queryRunes := cjkRunes(query)
	searchTokens := queryTokens(query)
	if len(queryRunes) == 0 || len(searchTokens) == 0 {
		return []Group{}, nil
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT d.entry_id, d.headword, d.scope, d.english_text, d.chinese_text,
		       d.section, d.part, d.owner_id, d.path_json, d.weight, bm25(documents_fts)
		FROM documents_fts
		JOIN documents d ON d.id = documents_fts.rowid
		WHERE documents_fts MATCH ?
			ORDER BY bm25(documents_fts) - (d.weight * 0.01), d.entry_id, d.id
			LIMIT ?`, matchExpression(searchTokens), defaultCandidates)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	candidates := make([]candidate, 0, 32)
	matcher := newCommonRunMatcher(queryRunes)
	for rows.Next() {
		var c candidate
		var pathJSON string
		if err := rows.Scan(&c.document.EntryID, &c.document.Headword, &c.document.Scope, &c.document.EnglishText, &c.document.ChineseText, &c.document.Location.Section, &c.document.Location.Part, &c.document.Location.OwnerID, &pathJSON, &c.document.Weight, &c.bm25); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(pathJSON), &c.document.Location.Path); err != nil {
			return nil, fmt.Errorf("invalid stored location path: %w", err)
		}
		c.score, c.exact, c.coverage, c.longest = scoreCandidate(queryRunes, matcher, c.document, c.bm25)
		candidates = append(candidates, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return groupCandidates(queryRunes, candidates, limit), nil
}

func scoreCandidate(
	queryRunes []rune,
	matcher commonRunMatcher,
	document SearchDocument,
	bm25 float64,
) (float64, bool, float64, int) {
	sequences := cjkSequences(document.ChineseText)
	if len(sequences) == 0 {
		return math.Inf(-1), false, 0, 0
	}
	exact := false
	longest := 0
	for _, sequence := range sequences {
		if strings.Contains(string(sequence), string(queryRunes)) {
			exact = true
		}
		if matched := matcher.longest(sequence); matched > longest {
			longest = matched
		}
	}
	bigramCoverage := coverageSequences(queryRunes, sequences)
	segmentExact, segmentBoundary, compactness := segmentMatchQuality(queryRunes, sequences)
	score := float64(document.Weight) - bm25
	if exact {
		score += 100
	}
	if segmentExact {
		score += 90
	} else if segmentBoundary {
		score += 25
	}
	score += compactness * 40
	score += bigramCoverage * 30
	score += float64(longest) * 3
	return score, exact, bigramCoverage, longest
}

func segmentMatchQuality(query []rune, sequences [][]rune) (exact, boundary bool, compactness float64) {
	for _, sequence := range sequences {
		start := runeSliceIndex(sequence, query)
		if start < 0 {
			continue
		}
		ratio := float64(len(query)) / float64(len(sequence))
		if ratio > compactness {
			compactness = ratio
		}
		if len(sequence) == len(query) {
			exact = true
		}
		if start == 0 || start+len(query) == len(sequence) {
			boundary = true
		}
	}
	return exact, boundary, compactness
}

func runeSliceIndex(target, query []rune) int {
	if len(query) == 0 || len(query) > len(target) {
		return -1
	}
	for start := 0; start <= len(target)-len(query); start++ {
		matched := true
		for offset := range query {
			if target[start+offset] != query[offset] {
				matched = false
				break
			}
		}
		if matched {
			return start
		}
	}
	return -1
}

func coverageSequences(query []rune, targets [][]rune) float64 {
	if len(query) < 2 {
		for _, target := range targets {
			if containsRune(target, query[0]) {
				return 1
			}
		}
		return 0
	}
	present := make(map[[2]rune]struct{})
	for _, target := range targets {
		for index := 1; index < len(target); index++ {
			present[[2]rune{target[index-1], target[index]}] = struct{}{}
		}
	}
	hits := 0
	for index := 1; index < len(query); index++ {
		if _, ok := present[[2]rune{query[index-1], query[index]}]; ok {
			hits++
		}
	}
	return float64(hits) / float64(len(query)-1)
}

func containsRune(values []rune, wanted rune) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func groupCandidates(query []rune, candidates []candidate, limit int) []Group {
	if len(candidates) == 0 {
		return []Group{}
	}
	// A one-character query is deliberately restricted to canonical definitions/forms.
	filtered := candidates[:0]
	for _, candidate := range candidates {
		if len(query) == 1 && candidate.document.Scope == ScopeExample {
			continue
		}
		filtered = append(filtered, candidate)
	}
	candidates = filtered
	if len(query) >= 2 && len(query) < 4 {
		filtered = candidates[:0]
		for _, candidate := range candidates {
			if candidate.longest >= 2 {
				filtered = append(filtered, candidate)
			}
		}
		candidates = filtered
	}
	if len(query) >= 4 {
		highCoverage := candidates[:0]
		for _, candidate := range candidates {
			if candidate.exact || candidate.coverage >= .6 {
				highCoverage = append(highCoverage, candidate)
			}
		}
		if len(highCoverage) > 0 {
			candidates = highCoverage
		} else {
			longest := 0
			for _, candidate := range candidates {
				if candidate.longest > longest {
					longest = candidate.longest
				}
			}
			filtered = candidates[:0]
			for _, candidate := range candidates {
				if longest >= 2 && candidate.longest == longest {
					filtered = append(filtered, candidate)
				}
			}
			candidates = filtered
		}
	}
	sort.SliceStable(candidates, func(left, right int) bool {
		if candidates[left].score != candidates[right].score {
			return candidates[left].score > candidates[right].score
		}
		if candidates[left].document.EntryID != candidates[right].document.EntryID {
			return candidates[left].document.EntryID < candidates[right].document.EntryID
		}
		return candidates[left].document.Headword < candidates[right].document.Headword
	})
	groups := make([]Group, 0, limit)
	byEntry := make(map[string]int, limit)
	for _, candidate := range candidates {
		index, exists := byEntry[candidate.document.EntryID]
		if !exists {
			if len(groups) == limit {
				continue
			}
			index = len(groups)
			byEntry[candidate.document.EntryID] = index
			groups = append(groups, Group{EntryID: candidate.document.EntryID, Headword: candidate.document.Headword, Matches: make([]Match, 0, maxMatches)})
		}
		if len(groups[index].Matches) == maxMatches {
			continue
		}
		groups[index].Matches = append(groups[index].Matches, Match{Scope: candidate.document.Scope, English: candidate.document.EnglishText, Chinese: candidate.document.ChineseText, Location: candidate.document.Location})
	}
	return groups
}
