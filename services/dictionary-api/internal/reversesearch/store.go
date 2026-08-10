package reversesearch

import (
	"cmp"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"path/filepath"
	"sort"
	"strings"

	"golang.org/x/text/unicode/norm"

	_ "modernc.org/sqlite"
)

type Store struct{ db *sql.DB }

const (
	highestCandidatePoolTier   = 3
	segmentCompactnessWeight   = 40
	overallCompactnessWeight   = 120
	positionQualityWeight      = 60
	leadingQueryCoverageWeight = 80
	bracketOnlyPenalty         = 90
	bigramCoverageWeight       = 30
	longestRunWeight           = 3
	negationMismatchPenalty    = 45
)

type candidate struct {
	id                int64
	document          SearchDocument
	bm25              float64
	score             float64
	matchTier         int
	exact             bool
	coverage          float64
	longest           int
	negationMismatch  bool
	candidatePoolTier int
	resultPriority    int
	corroboration     int
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
	for _, key := range []string{"source_version", "document_count", "segment_count", "form_count"} {
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
	var segmentCount int
	if err := db.QueryRow(`SELECT COUNT(*) FROM exact_segments`).Scan(&segmentCount); err != nil || segmentCount < 1 {
		return errors.New("reverse-search exact-segment index is missing or empty")
	}
	var storedSegmentCount string
	if err := db.QueryRow(`SELECT value FROM metadata WHERE key = 'segment_count'`).Scan(&storedSegmentCount); err != nil || storedSegmentCount != fmt.Sprintf("%d", segmentCount) {
		return errors.New("reverse-search exact-segment count metadata is invalid")
	}
	var formTableSQL string
	if err := db.QueryRow(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'entry_headword_forms'`).Scan(&formTableSQL); err != nil || !strings.Contains(strings.ToUpper(formTableSQL), "WITHOUT ROWID") {
		return errors.New("reverse-search headword-form table is missing or invalid")
	}
	var formCount int
	if err := db.QueryRow(`SELECT COUNT(*) FROM entry_headword_forms`).Scan(&formCount); err != nil {
		return errors.New("reverse-search headword-form table is unreadable")
	}
	var storedFormCount string
	if err := db.QueryRow(`SELECT value FROM metadata WHERE key = 'form_count'`).Scan(&storedFormCount); err != nil || storedFormCount != fmt.Sprintf("%d", formCount) {
		return errors.New("reverse-search headword-form count metadata is invalid")
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

// HeadwordForms returns normalized forms for at most one reverse-search result window.
func (s *Store) HeadwordForms(ctx context.Context, entryIDs []string) (map[string][]string, error) {
	formsByEntry := make(map[string][]string)
	if len(entryIDs) == 0 {
		return formsByEntry, nil
	}
	if s == nil || s.db == nil {
		return formsByEntry, errors.New("reverse-search store is unavailable")
	}

	uniqueIDs := make([]string, 0, len(entryIDs))
	seen := make(map[string]struct{}, len(entryIDs))
	for _, entryID := range entryIDs {
		if !validLimited(entryID, maxIDBytes) {
			return formsByEntry, errors.New("headword-form entry id is invalid or oversized")
		}
		if _, exists := seen[entryID]; exists {
			continue
		}
		seen[entryID] = struct{}{}
		uniqueIDs = append(uniqueIDs, entryID)
		if len(uniqueIDs) > maxResults {
			return formsByEntry, fmt.Errorf("headword-form lookup exceeds %d unique entries", maxResults)
		}
	}

	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(uniqueIDs)), ",")
	arguments := make([]any, len(uniqueIDs))
	for index, entryID := range uniqueIDs {
		arguments[index] = entryID
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT entry_id, form
		FROM entry_headword_forms
		WHERE entry_id IN (`+placeholders+`)
		ORDER BY entry_id, form`, arguments...)
	if err != nil {
		return formsByEntry, fmt.Errorf("query headword forms: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var entryID, form string
		if err := rows.Scan(&entryID, &form); err != nil {
			return formsByEntry, fmt.Errorf("scan headword forms: %w", err)
		}
		formsByEntry[entryID] = append(formsByEntry[entryID], form)
	}
	if err := rows.Err(); err != nil {
		return formsByEntry, fmt.Errorf("read headword forms: %w", err)
	}
	return formsByEntry, nil
}

func (s *Store) Search(ctx context.Context, query string, options Options) ([]Group, error) {
	options.Offset = 0
	page, err := s.SearchPage(ctx, query, options)
	return page.Groups, err
}

func (s *Store) SearchPage(ctx context.Context, query string, options Options) (Page, error) {
	empty := Page{Groups: []Group{}}
	scopes, err := options.Scopes.values()
	if err != nil {
		return empty, err
	}
	offset, limit := options.Offset, options.Limit
	if s == nil || s.db == nil || limit < 1 {
		return empty, nil
	}
	if offset < 0 {
		return empty, errors.New("reverse-search offset must not be negative")
	}
	if len([]rune(query)) > MaxQueryRunes {
		return empty, fmt.Errorf("reverse-search query exceeds %d characters", MaxQueryRunes)
	}
	if offset >= maxResults {
		return empty, nil
	}
	if limit > maxResults-offset {
		limit = maxResults - offset
	}
	groupLimit := offset + limit
	if groupLimit < maxResults {
		groupLimit++
	}
	normalizedQuery := normalizeChinese(query)
	querySequences := cjkSequencesFromNormalized(normalizedQuery)
	queryRunes := cjkRunesFromSequences(querySequences)
	asciiTerms := asciiQueryTerms(query)
	searchTokens := queryTokensFromSequences(querySequences)
	if len(queryRunes) == 0 || len(searchTokens) == 0 {
		return empty, nil
	}
	matcher := newCommonRunMatcher(queryRunes)
	exactCandidates := []candidate{}
	if len(querySequences) == 1 {
		var err error
		exactCandidates, err = s.searchExactCandidates(ctx, string(querySequences[0]), queryRunes, matcher, scopes, asciiTerms)
		if err != nil {
			return empty, err
		}
	}
	preciseCandidates := []candidate{}
	fallbackScopes := scopes
	if len(searchTokens) > 1 {
		preciseCandidates, err = s.searchCandidates(
			ctx,
			conjunctiveMatchExpression(searchTokens),
			queryRunes,
			matcher,
			scopes,
			asciiTerms,
		)
		if err != nil {
			return empty, err
		}
		preciseCandidates = filterCandidatesByASCII(mergeCandidates(preciseCandidates, exactCandidates), asciiTerms)
		preciseCandidates = filterCandidatesForQuery(queryRunes, preciseCandidates)
		fallbackScopes = scopesWithoutCandidateTiers(scopes, preciseCandidates)
		if len(fallbackScopes) == 0 {
			return paginateGroups(groupCandidates(queryRunes, preciseCandidates, groupLimit), offset, limit), nil
		}
	}
	candidates, err := s.searchCandidates(ctx, matchExpression(searchTokens), queryRunes, matcher, fallbackScopes, asciiTerms)
	if err != nil {
		return empty, err
	}
	candidates = mergeCandidates(candidates, preciseCandidates)
	if len(searchTokens) == 1 {
		candidates = mergeCandidates(candidates, exactCandidates)
	}
	candidates = filterCandidatesByASCII(candidates, asciiTerms)
	return paginateGroups(groupCandidates(queryRunes, candidates, groupLimit), offset, limit), nil
}

func paginateGroups(groups []Group, offset, limit int) Page {
	if offset >= len(groups) {
		return Page{Groups: []Group{}}
	}
	end := offset + limit
	if end > len(groups) {
		end = len(groups)
	}
	page := Page{Groups: groups[offset:end]}
	if end < len(groups) {
		page.HasMore = true
		page.NextOffset = end
	}
	return page
}

func (s *Store) searchCandidates(
	ctx context.Context,
	match string,
	queryRunes []rune,
	matcher commonRunMatcher,
	scopes []Scope,
	asciiTerms []string,
) ([]candidate, error) {
	partitions := partitionScopesByCandidatePool(scopes)
	var candidates []candidate
	for _, partition := range partitions {
		predicate, predicateArguments := candidatePredicate(partition, asciiTerms)
		statement := fmt.Sprintf(`
							SELECT d.id, d.entry_id, d.headword, d.scope, d.english_text, d.candidate_text, d.definition_text, d.chinese_text,
						       d.section, d.part, d.owner_id, d.path_json, d.weight, bm25(documents_fts)
				FROM documents_fts
				JOIN documents d ON d.id = documents_fts.rowid
					WHERE documents_fts MATCH ? AND %s
						ORDER BY bm25(documents_fts) - (d.weight * 0.01), d.entry_id, d.id
						LIMIT ?`, predicate)
		arguments := make([]any, 0, len(predicateArguments)+2)
		arguments = append(arguments, match)
		arguments = append(arguments, predicateArguments...)
		arguments = append(arguments, defaultCandidates)
		rows, err := s.db.QueryContext(ctx, statement, arguments...)
		if err != nil {
			return nil, err
		}
		partitionCandidates, err := scanCandidates(ctx, rows, queryRunes, matcher)
		if err != nil {
			return nil, err
		}
		candidates = append(candidates, partitionCandidates...)
	}
	return candidates, nil
}

func (s *Store) searchExactCandidates(
	ctx context.Context,
	normalized string,
	queryRunes []rune,
	matcher commonRunMatcher,
	scopes []Scope,
	asciiTerms []string,
) ([]candidate, error) {
	partitions := partitionScopesByCandidatePool(scopes)
	var candidates []candidate
	for _, partition := range partitions {
		predicate, predicateArguments := candidatePredicate(partition, asciiTerms)
		statement := fmt.Sprintf(`
						SELECT d.id, d.entry_id, d.headword, d.scope, d.english_text, d.candidate_text, d.definition_text, d.chinese_text,
					       d.section, d.part, d.owner_id, d.path_json, d.weight, 0.0
					FROM exact_segments x
					JOIN documents d ON d.id = x.document_id
					WHERE x.normalized = ? AND %s
					ORDER BY d.weight DESC, d.entry_id, d.id
					LIMIT ?`, predicate)
		arguments := make([]any, 0, len(predicateArguments)+2)
		arguments = append(arguments, normalized)
		arguments = append(arguments, predicateArguments...)
		arguments = append(arguments, defaultCandidates)
		rows, err := s.db.QueryContext(ctx, statement, arguments...)
		if err != nil {
			return nil, err
		}
		partitionCandidates, err := scanCandidates(ctx, rows, queryRunes, matcher)
		if err != nil {
			return nil, err
		}
		candidates = append(candidates, partitionCandidates...)
	}
	return candidates, nil
}

func partitionScopesByCandidatePool(scopes []Scope) [][]Scope {
	byTier := make([][]Scope, highestCandidatePoolTier+1)
	for _, scope := range scopes {
		tier := candidatePoolTier(scope)
		if tier < 0 || tier > highestCandidatePoolTier {
			tier = 0
		}
		byTier[tier] = append(byTier[tier], scope)
	}
	partitions := make([][]Scope, 0, highestCandidatePoolTier)
	for tier := highestCandidatePoolTier; tier >= 0; tier-- {
		if len(byTier[tier]) > 0 {
			partitions = append(partitions, byTier[tier])
		}
	}
	return partitions
}

func scopesWithoutCandidateTiers(scopes []Scope, candidates []candidate) []Scope {
	var matchedTiers [highestCandidatePoolTier + 1]bool
	for _, candidate := range candidates {
		if candidate.candidatePoolTier >= 0 && candidate.candidatePoolTier <= highestCandidatePoolTier {
			matchedTiers[candidate.candidatePoolTier] = true
		}
	}
	missing := make([]Scope, 0, len(scopes))
	for _, scope := range scopes {
		if !matchedTiers[candidatePoolTier(scope)] {
			missing = append(missing, scope)
		}
	}
	return missing
}

func scopePredicate(scopes []Scope) (string, []any) {
	placeholders := make([]string, len(scopes))
	arguments := make([]any, len(scopes))
	for index, scope := range scopes {
		placeholders[index] = "?"
		arguments[index] = scope
	}
	return "d.scope IN (" + strings.Join(placeholders, ",") + ")", arguments
}

func candidatePredicate(scopes []Scope, asciiTerms []string) (string, []any) {
	scope, arguments := scopePredicate(scopes)
	clauses := []string{scope}
	for _, term := range asciiTerms {
		clauses = append(clauses, "instr(lower(d.headword || ' ' || d.english_text || ' ' || d.chinese_text), ?) > 0")
		arguments = append(arguments, term)
	}
	return strings.Join(clauses, " AND "), arguments
}

func scanCandidates(
	ctx context.Context,
	rows *sql.Rows,
	queryRunes []rune,
	matcher commonRunMatcher,
) ([]candidate, error) {
	defer rows.Close()
	candidates := make([]candidate, 0, 32)
	for rows.Next() {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		var c candidate
		var pathJSON string
		if err := rows.Scan(&c.id, &c.document.EntryID, &c.document.Headword, &c.document.Scope, &c.document.EnglishText, &c.document.CandidateText, &c.document.DefinitionText, &c.document.ChineseText, &c.document.Location.Section, &c.document.Location.Part, &c.document.Location.OwnerID, &pathJSON, &c.document.Weight, &c.bm25); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(pathJSON), &c.document.Location.Path); err != nil {
			return nil, fmt.Errorf("invalid stored location path: %w", err)
		}
		c.score, c.matchTier, c.exact, c.coverage, c.longest, c.negationMismatch = scoreCandidate(queryRunes, matcher, c.document, c.bm25)
		c.candidatePoolTier = candidatePoolTier(c.document.Scope)
		c.resultPriority = scopeResultPriority(c.document.Scope)
		candidates = append(candidates, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return candidates, nil
}

func mergeCandidates(primary, additional []candidate) []candidate {
	if len(additional) == 0 {
		return primary
	}
	seen := make(map[int64]struct{}, len(primary)+len(additional))
	for _, item := range primary {
		seen[item.id] = struct{}{}
	}
	for _, item := range additional {
		if _, exists := seen[item.id]; exists {
			continue
		}
		seen[item.id] = struct{}{}
		primary = append(primary, item)
	}
	return primary
}

func filterCandidatesByASCII(candidates []candidate, terms []string) []candidate {
	if len(terms) == 0 {
		return candidates
	}
	filtered := candidates[:0]
	for _, item := range candidates {
		searchable := strings.ToLower(norm.NFKC.String(strings.Join([]string{
			item.document.Headword,
			item.document.EnglishText,
			item.document.ChineseText,
		}, " ")))
		matched := true
		for _, term := range terms {
			if !strings.Contains(searchable, term) {
				matched = false
				break
			}
		}
		if matched {
			filtered = append(filtered, item)
		}
	}
	return filtered
}

func scoreCandidate(
	queryRunes []rune,
	matcher commonRunMatcher,
	document SearchDocument,
	bm25 float64,
) (float64, int, bool, float64, int, bool) {
	sequences := cjkSequencesWithoutTraditionalConversion(document.ChineseText)
	if coverageSequences(queryRunes, sequences) < 1 {
		sequences = cjkSequences(document.ChineseText)
	}
	if len(sequences) == 0 {
		return math.Inf(-1), 0, false, 0, 0, false
	}
	exact := false
	longest := 0
	polarityMatchAtLongest := false
	queryNegation := hasNegation(queryRunes)
	for _, sequence := range sequences {
		if strings.Contains(string(sequence), string(queryRunes)) {
			exact = true
		}
		matched := matcher.longest(sequence)
		polarityMatches := hasNegation(sequence) == queryNegation
		if matched > longest {
			longest = matched
			polarityMatchAtLongest = polarityMatches
		} else if matched == longest && polarityMatches {
			polarityMatchAtLongest = true
		}
	}
	negationMismatch := longest > 0 && !polarityMatchAtLongest
	bigramCoverage := coverageSequences(queryRunes, sequences)
	leadingCoverage := leadingQueryCoverage(queryRunes, sequences)
	segmentExact, grammaticalExtension, segmentBoundary, compactness, positionQuality := segmentMatchQuality(queryRunes, sequences)
	totalRunes := 0
	for _, sequence := range sequences {
		totalRunes += len(sequence)
	}
	overallCompactness := float64(len(queryRunes)) / float64(totalRunes)
	bracketOnly := exactMatchOnlyInsideBrackets(document.ChineseText, queryRunes)
	matchTier := 1
	if segmentExact && !bracketOnly {
		matchTier = 4
	} else if grammaticalExtension {
		matchTier = 3
	} else if segmentBoundary || exact {
		matchTier = 2
	}
	score := float64(document.Weight) - bm25
	score += compactness * segmentCompactnessWeight
	score += overallCompactness * overallCompactnessWeight
	score += positionQuality * positionQualityWeight
	score += leadingCoverage * leadingQueryCoverageWeight
	if bracketOnly {
		score -= bracketOnlyPenalty
	}
	score += bigramCoverage * bigramCoverageWeight
	score += float64(longest) * longestRunWeight
	if negationMismatch {
		score -= negationMismatchPenalty
	}
	return score, matchTier, exact, bigramCoverage, longest, negationMismatch
}

func candidatePoolTier(scope Scope) int {
	switch scope {
	case ScopeSense, ScopePhrase, ScopeForm:
		return 3
	case ScopeUsage:
		return 2
	case ScopeExample:
		return 1
	default:
		return 0
	}
}

func scopeResultPriority(scope Scope) int {
	switch scope {
	case ScopeSense:
		return 3
	case ScopePhrase, ScopeForm:
		return 2
	case ScopeUsage:
		return 1
	case ScopeExample:
		return 0
	default:
		return -1
	}
}

func segmentMatchQuality(query []rune, sequences [][]rune) (exact, grammaticalExtension, boundary bool, compactness, positionQuality float64) {
	for index, sequence := range sequences {
		start := runeSliceIndex(sequence, query)
		if start < 0 {
			continue
		}
		ratio := float64(len(query)) / float64(len(sequence))
		if ratio > compactness {
			compactness = ratio
		}
		position := 1 / float64(index+1)
		if position > positionQuality {
			positionQuality = position
		}
		if len(sequence) == len(query) {
			exact = true
		}
		if len(sequence) == len(query)+1 && start == 0 {
			switch sequence[len(query)] {
			case '的', '地', '得':
				grammaticalExtension = true
			}
		}
		if start == 0 || start+len(query) == len(sequence) {
			boundary = true
		}
	}
	return exact, grammaticalExtension, boundary, compactness, positionQuality
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

func leadingQueryCoverage(query []rune, targets [][]rune) float64 {
	if len(query) == 0 {
		return 0
	}
	longest := 0
	for _, target := range targets {
		for start, value := range target {
			if value != query[0] {
				continue
			}
			length := 1
			for length < len(query) && start+length < len(target) && target[start+length] == query[length] {
				length++
			}
			if length > longest {
				longest = length
			}
		}
	}
	return float64(longest) / float64(len(query))
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
	candidates = filterCandidatesForQuery(query, candidates)
	qualityCounts := make(map[candidateQuality]int, len(candidates))
	seenEvidence := make(map[candidateEvidence]struct{}, len(candidates))
	for _, item := range candidates {
		quality := candidateQuality{
			entryID:        item.document.EntryID,
			matchTier:      item.matchTier,
			resultPriority: item.resultPriority,
		}
		evidence := candidateEvidence{candidateQuality: quality, chineseText: item.document.ChineseText}
		if _, exists := seenEvidence[evidence]; !exists && qualityCounts[quality] < maxMatches {
			seenEvidence[evidence] = struct{}{}
			qualityCounts[quality]++
		}
	}
	for index := range candidates {
		candidates[index].corroboration = qualityCounts[candidateQuality{
			entryID:        candidates[index].document.EntryID,
			matchTier:      candidates[index].matchTier,
			resultPriority: candidates[index].resultPriority,
		}]
	}
	sort.SliceStable(candidates, func(left, right int) bool {
		if relevance := compareCandidateRelevance(candidates[left], candidates[right]); relevance != 0 {
			return relevance > 0
		}
		if candidates[left].document.EntryID != candidates[right].document.EntryID {
			return candidates[left].document.EntryID < candidates[right].document.EntryID
		}
		if candidates[left].document.Headword != candidates[right].document.Headword {
			return candidates[left].document.Headword < candidates[right].document.Headword
		}
		return candidates[left].id < candidates[right].id
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
			groups = append(groups, Group{
				EntryID:   candidate.document.EntryID,
				Headword:  candidate.document.Headword,
				Relevance: candidateRelevance(candidate),
				Matches:   make([]Match, 0, maxMatches),
			})
		}
		if len(groups[index].Matches) == maxMatches {
			continue
		}
		groups[index].Matches = append(groups[index].Matches, Match{
			Scope:          candidate.document.Scope,
			English:        candidate.document.EnglishText,
			CandidateText:  candidate.document.CandidateText,
			DefinitionText: candidate.document.DefinitionText,
			Chinese:        candidate.document.ChineseText,
			Location:       candidate.document.Location,
			Relevance:      candidateRelevance(candidate),
		})
	}
	return groups
}

func candidateRelevance(candidate candidate) Relevance {
	return Relevance{
		Tier:           candidate.matchTier,
		Score:          candidate.score,
		Corroboration:  candidate.corroboration,
		DocumentWeight: candidate.document.Weight,
	}
}

func compareCandidateRelevance(left, right candidate) int {
	if order := cmp.Compare(left.matchTier, right.matchTier); order != 0 {
		return order
	}
	if order := cmp.Compare(left.candidatePoolTier, right.candidatePoolTier); order != 0 {
		return order
	}
	// Scope refines complete matches; partial fallbacks remain ordered by textual relevance.
	if left.matchTier > 1 {
		if order := cmp.Compare(left.resultPriority, right.resultPriority); order != 0 {
			return order
		}
		if order := cmp.Compare(left.corroboration, right.corroboration); order != 0 {
			return order
		}
		return cmp.Compare(left.score, right.score)
	}
	if order := cmp.Compare(left.score, right.score); order != 0 {
		return order
	}
	if order := cmp.Compare(left.resultPriority, right.resultPriority); order != 0 {
		return order
	}
	return cmp.Compare(left.corroboration, right.corroboration)
}

type candidateQuality struct {
	entryID        string
	matchTier      int
	resultPriority int
}

type candidateEvidence struct {
	candidateQuality
	chineseText string
}

func filterCandidatesForQuery(query []rune, candidates []candidate) []candidate {
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
		minimumRun := minimumPartialRun(len(query))
		highCoverage := candidates[:0]
		for _, candidate := range candidates {
			if candidate.exact || (!candidate.negationMismatch && candidate.coverage >= .6 && candidate.longest >= minimumRun) {
				highCoverage = append(highCoverage, candidate)
			}
		}
		if len(highCoverage) > 0 {
			candidates = highCoverage
		} else {
			longest := 0
			for _, candidate := range candidates {
				if !candidate.negationMismatch && candidate.longest > longest {
					longest = candidate.longest
				}
			}
			filtered = candidates[:0]
			for _, candidate := range candidates {
				if longest >= minimumRun && !candidate.negationMismatch && candidate.longest == longest {
					filtered = append(filtered, candidate)
				}
			}
			candidates = filtered
		}
	}
	return candidates
}

func minimumPartialRun(queryLength int) int {
	minimum := (queryLength + 1) / 2
	if minimum < 3 {
		return 3
	}
	return minimum
}
