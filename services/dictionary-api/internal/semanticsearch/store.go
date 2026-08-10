package semanticsearch

import (
	"bytes"
	"container/heap"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"

	_ "modernc.org/sqlite"
)

type Store struct {
	db             *sql.DB
	dimensions     int
	modelKey       string
	queryTemplate  string
	queryExtraJSON []byte
	vectors        []int8
	scopeMasks     []uint32
}

type metadata struct {
	dimensions     int
	modelKey       string
	queryTemplate  string
	queryExtraJSON []byte
	vectorCount    int
	blockSize      int
}

func Open(path, expectedPrimarySHA256, expectedReverseSHA256, expectedProjectionVersion, expectedModelKey string) (*Store, error) {
	for name, value := range map[string]string{
		"sidecar path": path, "primary SHA-256": expectedPrimarySHA256,
		"reverse-search SHA-256": expectedReverseSHA256, "projection version": expectedProjectionVersion,
		"model key": expectedModelKey,
	} {
		if strings.TrimSpace(value) == "" {
			return nil, fmt.Errorf("semantic-search %s is required", name)
		}
	}
	db, err := sql.Open("sqlite", sqliteReadOnlyDSN(path))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("open semantic-search sidecar: %w", err)
	}
	meta, err := validateMetadata(db, expectedPrimarySHA256, expectedReverseSHA256, expectedProjectionVersion, expectedModelKey)
	if err != nil {
		_ = db.Close()
		return nil, err
	}
	vectors, masks, err := loadVectors(db, meta)
	if err != nil {
		_ = db.Close()
		return nil, err
	}
	if err := validateDocumentsTable(db, meta.vectorCount); err != nil {
		_ = db.Close()
		return nil, err
	}
	return &Store{db: db, dimensions: meta.dimensions, modelKey: meta.modelKey, queryTemplate: meta.queryTemplate, queryExtraJSON: cloneBytes(meta.queryExtraJSON), vectors: vectors, scopeMasks: masks}, nil
}

func sqliteReadOnlyDSN(path string) string { return "file:" + filepath.ToSlash(path) + "?mode=ro" }

func validateMetadata(db *sql.DB, primarySHA256, reverseSHA256, projectionVersion, modelKey string) (metadata, error) {
	expected := map[string]string{
		"schema_version":        SchemaVersion,
		"primary_sha256":        primarySHA256,
		"reverse_search_sha256": reverseSHA256,
		"projection_version":    projectionVersion,
		"model_key":             modelKey,
		"normalization":         "l2",
		"quantization":          "symmetric-int8-127",
	}
	for key, wanted := range expected {
		actual, err := metadataValue(db, key)
		if err != nil {
			return metadata{}, err
		}
		if actual != wanted {
			return metadata{}, fmt.Errorf("semantic-search metadata %q does not match", key)
		}
	}
	dimensions, err := positiveMetadataInt(db, "dimensions", maxDimensions)
	if err != nil {
		return metadata{}, err
	}
	vectorCount, err := positiveMetadataInt(db, "vector_count", maxVectors)
	if err != nil {
		return metadata{}, err
	}
	blockSize, err := positiveMetadataInt(db, "block_size", vectorCount)
	if err != nil {
		return metadata{}, err
	}
	if vectorCount > maxResidentVectorB/dimensions {
		return metadata{}, errors.New("semantic-search sidecar exceeds resident vector memory limit")
	}
	queryTemplate, err := metadataValue(db, "query_template")
	if err != nil {
		return metadata{}, err
	}
	if err := validateQueryTemplate(queryTemplate); err != nil {
		return metadata{}, fmt.Errorf("semantic-search metadata %q is invalid: %w", "query_template", err)
	}
	queryExtraJSON, err := metadataValue(db, "query_extra_json")
	if err != nil {
		return metadata{}, err
	}
	if err := validateQueryExtraJSON([]byte(queryExtraJSON)); err != nil {
		return metadata{}, fmt.Errorf("semantic-search metadata %q is invalid: %w", "query_extra_json", err)
	}
	return metadata{dimensions: dimensions, modelKey: modelKey, queryTemplate: queryTemplate, queryExtraJSON: []byte(queryExtraJSON), vectorCount: vectorCount, blockSize: blockSize}, nil
}

func metadataValue(db *sql.DB, key string) (string, error) {
	var value string
	if err := db.QueryRow(`SELECT value FROM metadata WHERE key = ?`, key).Scan(&value); err != nil {
		return "", fmt.Errorf("semantic-search metadata %q is missing: %w", key, err)
	}
	if strings.TrimSpace(value) == "" {
		return "", fmt.Errorf("semantic-search metadata %q is empty", key)
	}
	return value, nil
}

func positiveMetadataInt(db *sql.DB, key string, maximum int) (int, error) {
	value, err := metadataValue(db, key)
	if err != nil {
		return 0, err
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < 1 || parsed > maximum {
		return 0, fmt.Errorf("semantic-search metadata %q is invalid", key)
	}
	return parsed, nil
}

func loadVectors(db *sql.DB, meta metadata) ([]int8, []uint32, error) {
	var count, minimum, maximum int
	if err := db.QueryRow(`SELECT COUNT(*), MIN(id), MAX(id) FROM texts`).Scan(&count, &minimum, &maximum); err != nil || count != meta.vectorCount || minimum != 0 || maximum != meta.vectorCount-1 {
		return nil, nil, errors.New("semantic-search texts table is missing, incomplete, or has non-contiguous IDs")
	}
	masks := make([]uint32, meta.vectorCount)
	rows, err := db.Query(`SELECT id, scope_mask FROM texts ORDER BY id`)
	if err != nil {
		return nil, nil, fmt.Errorf("read semantic-search texts: %w", err)
	}
	defer rows.Close()
	for expectedID := 0; rows.Next(); expectedID++ {
		var id int
		var mask uint32
		if err := rows.Scan(&id, &mask); err != nil || id != expectedID || mask == 0 || mask>>len(orderedScopes) != 0 {
			return nil, nil, errors.New("semantic-search text scopes are invalid")
		}
		masks[id] = mask
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	vectors := make([]int8, 0, meta.vectorCount*meta.dimensions)
	blocks, err := db.Query(`SELECT block_index, first_vector_id, vector_count, data FROM vector_blocks ORDER BY block_index`)
	if err != nil {
		return nil, nil, fmt.Errorf("read semantic-search vector blocks: %w", err)
	}
	defer blocks.Close()
	nextVectorID, expectedBlock := 0, 0
	for blocks.Next() {
		var index, firstID, count int
		var data []byte
		if err := blocks.Scan(&index, &firstID, &count, &data); err != nil {
			return nil, nil, err
		}
		if index != expectedBlock || firstID != nextVectorID || count < 1 || count > meta.blockSize || count > meta.vectorCount-nextVectorID || len(data) != count*meta.dimensions {
			return nil, nil, errors.New("semantic-search vector blocks are invalid or incomplete")
		}
		for _, value := range data {
			vectors = append(vectors, int8(value))
		}
		nextVectorID += count
		expectedBlock++
	}
	if err := blocks.Err(); err != nil || nextVectorID != meta.vectorCount {
		return nil, nil, errors.New("semantic-search vector blocks do not cover all texts")
	}
	return vectors, masks, nil
}

func validateDocumentsTable(db *sql.DB, vectorCount int) error {
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM documents`).Scan(&count); err != nil {
		return fmt.Errorf("semantic-search documents table is missing: %w", err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM documents WHERE text_id < 0 OR text_id >= ?`, vectorCount).Scan(&count); err != nil || count != 0 {
		return errors.New("semantic-search documents reference invalid text IDs")
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM pragma_index_list('documents') AS l, pragma_index_info(l.name) AS i WHERE i.name = 'text_id'`).Scan(&count); err != nil || count == 0 {
		return errors.New("semantic-search documents text_id index is missing")
	}
	return nil
}

func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *Store) Available() bool { return s != nil && s.db != nil && len(s.scopeMasks) > 0 }

func (s *Store) Dimensions() int {
	if s == nil {
		return 0
	}
	return s.dimensions
}

func (s *Store) ModelKey() string {
	if s == nil {
		return ""
	}
	return s.modelKey
}

func (s *Store) QueryTemplate() string {
	if s == nil {
		return ""
	}
	return s.queryTemplate
}

func (s *Store) QueryExtraJSON() []byte {
	if s == nil {
		return nil
	}
	return cloneBytes(s.queryExtraJSON)
}

func validateQueryExtraJSON(raw []byte) error {
	if len(raw) == 0 || len(raw) > maxQueryExtraJSONB {
		return fmt.Errorf("query extra JSON must be between 1 and %d bytes", maxQueryExtraJSONB)
	}
	var values map[string]json.RawMessage
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if err := decoder.Decode(&values); err != nil || values == nil {
		return errors.New("query extra JSON must be an object")
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return errors.New("query extra JSON contains trailing values")
	}
	for key := range values {
		switch key {
		case "model", "input", "encoding_format", "dimensions":
			return fmt.Errorf("query extra JSON must not override reserved field %q", key)
		}
	}
	return nil
}

func cloneBytes(value []byte) []byte { return append([]byte(nil), value...) }

func (s *Store) Search(ctx context.Context, queryVector []float32, options Options) (Page, error) {
	empty := Page{Groups: []Group{}}
	if s == nil || !s.Available() || options.Limit < 1 {
		return empty, nil
	}
	if options.Offset < 0 {
		return empty, errors.New("semantic-search offset must not be negative")
	}
	if options.Offset >= maximumResultGroups {
		return empty, nil
	}
	if options.Limit > maximumResultGroups-options.Offset {
		options.Limit = maximumResultGroups - options.Offset
	}
	if _, err := options.Scopes.values(); err != nil {
		return empty, err
	}
	query, err := normalizeAndQuantize(queryVector, s.dimensions)
	if err != nil {
		return empty, err
	}
	candidateCount, err := candidatePoolLimit(options.Offset, options.Limit)
	if err != nil {
		return empty, err
	}
	candidates, err := s.topCandidates(ctx, query, options.Scopes.mask, candidateCount)
	if err != nil || len(candidates) == 0 {
		return empty, err
	}
	documents, err := s.documentsForCandidates(ctx, candidates, options.Scopes)
	if err != nil {
		return empty, err
	}
	return groupAndPaginate(documents, options.Offset, options.Limit), nil
}

func candidatePoolLimit(offset, limit int) (int, error) {
	if offset < 0 || limit < 0 || offset > math.MaxInt-limit-1 {
		return 0, errors.New("semantic-search pagination is too large")
	}
	groups := offset + limit + 1
	if groups > math.MaxInt/24 {
		return 0, errors.New("semantic-search pagination is too large")
	}
	candidates := groups * 24
	if candidates < 192 {
		return 192, nil
	}
	if candidates > maximumCandidatePool {
		return maximumCandidatePool, nil
	}
	return candidates, nil
}

func normalizeAndQuantize(vector []float32, dimensions int) ([]int8, error) {
	if len(vector) != dimensions {
		return nil, fmt.Errorf("semantic-search query dimensions must equal %d", dimensions)
	}
	var sum float64
	for _, value := range vector {
		if math.IsNaN(float64(value)) || math.IsInf(float64(value), 0) {
			return nil, errors.New("semantic-search query contains a non-finite value")
		}
		sum += float64(value) * float64(value)
	}
	if sum == 0 || math.IsInf(sum, 0) || math.IsNaN(sum) {
		return nil, errors.New("semantic-search query must not be a zero vector")
	}
	norm := math.Sqrt(sum)
	quantized := make([]int8, len(vector))
	for index, value := range vector {
		q := math.Round(float64(value) / norm * 127)
		if q > 127 {
			q = 127
		} else if q < -127 {
			q = -127
		}
		quantized[index] = int8(q)
	}
	return quantized, nil
}

type vectorCandidate struct {
	textID int
	dot    int32
}

type candidateHeap []vectorCandidate

func (h candidateHeap) Len() int { return len(h) }
func (h candidateHeap) Less(i, j int) bool {
	if h[i].dot != h[j].dot {
		return h[i].dot < h[j].dot
	}
	return h[i].textID > h[j].textID
}
func (h candidateHeap) Swap(i, j int)   { h[i], h[j] = h[j], h[i] }
func (h *candidateHeap) Push(value any) { *h = append(*h, value.(vectorCandidate)) }
func (h *candidateHeap) Pop() any {
	items := *h
	value := items[len(items)-1]
	*h = items[:len(items)-1]
	return value
}

func (s *Store) topCandidates(ctx context.Context, query []int8, scopeMask uint32, limit int) ([]vectorCandidate, error) {
	workers := runtime.GOMAXPROCS(0)
	if workers > 4 {
		workers = 4
	}
	if workers < 1 {
		workers = 1
	}
	if workers > len(s.scopeMasks) {
		workers = len(s.scopeMasks)
	}
	results := make(chan candidateHeap, workers)
	chunk := (len(s.scopeMasks) + workers - 1) / workers
	for worker := 0; worker < workers; worker++ {
		start := worker * chunk
		end := start + chunk
		if end > len(s.scopeMasks) {
			end = len(s.scopeMasks)
		}
		go func(start, end int) {
			local := candidateHeap{}
			heap.Init(&local)
			defer func() { results <- local }()
			for textID := start; textID < end; textID++ {
				if textID&255 == 0 {
					if ctx.Err() != nil {
						return
					}
				}
				if s.scopeMasks[textID]&scopeMask == 0 {
					continue
				}
				offset := textID * s.dimensions
				var dot int32
				for dimension, value := range query {
					dot += int32(value) * int32(s.vectors[offset+dimension])
				}
				candidate := vectorCandidate{textID: textID, dot: dot}
				if local.Len() < limit {
					heap.Push(&local, candidate)
				} else if betterCandidate(candidate, local[0]) {
					local[0] = candidate
					heap.Fix(&local, 0)
				}
			}
		}(start, end)
	}
	merged := candidateHeap{}
	heap.Init(&merged)
	for range workers {
		local := <-results
		for _, candidate := range local {
			if merged.Len() < limit {
				heap.Push(&merged, candidate)
			} else if betterCandidate(candidate, merged[0]) {
				merged[0] = candidate
				heap.Fix(&merged, 0)
			}
		}
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	result := make([]vectorCandidate, len(merged))
	copy(result, merged)
	sort.Slice(result, func(i, j int) bool { return betterCandidate(result[i], result[j]) })
	return result, nil
}

func betterCandidate(left, right vectorCandidate) bool {
	if left.dot != right.dot {
		return left.dot > right.dot
	}
	return left.textID < right.textID
}

type documentCandidate struct {
	documentID int64
	textID     int
	entryID    string
	headword   string
	scope      Scope
	english    string
	chinese    string
	location   Location
	weight     int
	dot        int32
}

func (s *Store) documentsForCandidates(ctx context.Context, candidates []vectorCandidate, filter ScopeFilter) ([]documentCandidate, error) {
	if len(candidates) == 0 {
		return nil, nil
	}
	dots := make(map[int]int32, len(candidates))
	ids := make([]string, len(candidates))
	arguments := make([]any, 0, len(candidates)+len(orderedScopes))
	for index, candidate := range candidates {
		dots[candidate.textID] = candidate.dot
		ids[index] = "?"
		arguments = append(arguments, candidate.textID)
	}
	scopes, _ := filter.values()
	scopeMarks := make([]string, len(scopes))
	for index, scope := range scopes {
		scopeMarks[index] = "?"
		arguments = append(arguments, scope)
	}
	statement := `SELECT rowid, text_id, entry_id, headword, scope, english_text, chinese_text, section, part, owner_id, path_json, weight
		FROM documents WHERE text_id IN (` + strings.Join(ids, ",") + `) AND scope IN (` + strings.Join(scopeMarks, ",") + `)`
	rows, err := s.db.QueryContext(ctx, statement, arguments...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]documentCandidate, 0, len(candidates))
	for rows.Next() {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		var item documentCandidate
		var pathJSON string
		var scope string
		if err := rows.Scan(&item.documentID, &item.textID, &item.entryID, &item.headword, &scope, &item.english, &item.chinese, &item.location.Section, &item.location.Part, &item.location.OwnerID, &pathJSON, &item.weight); err != nil {
			return nil, err
		}
		if scopeIndex(Scope(scope)) < 0 {
			return nil, fmt.Errorf("semantic-search document has invalid scope %q", scope)
		}
		item.scope = Scope(scope)
		if err := json.Unmarshal([]byte(pathJSON), &item.location.Path); err != nil {
			return nil, fmt.Errorf("invalid stored semantic-search location path: %w", err)
		}
		item.dot = dots[item.textID]
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func groupAndPaginate(candidates []documentCandidate, offset, limit int) Page {
	if len(candidates) == 0 || offset >= len(candidates) {
		return Page{Groups: []Group{}}
	}
	sort.Slice(candidates, func(i, j int) bool {
		left, right := candidates[i], candidates[j]
		if left.dot != right.dot {
			return left.dot > right.dot
		}
		if left.weight != right.weight {
			return left.weight > right.weight
		}
		if left.entryID != right.entryID {
			return left.entryID < right.entryID
		}
		if left.headword != right.headword {
			return left.headword < right.headword
		}
		return left.documentID < right.documentID
	})
	groups := make([]Group, 0, len(candidates))
	byEntry := make(map[string]int, len(candidates))
	for _, candidate := range candidates {
		index, exists := byEntry[candidate.entryID]
		if !exists {
			index = len(groups)
			byEntry[candidate.entryID] = index
			groups = append(groups, Group{EntryID: candidate.entryID, Headword: candidate.headword, Score: score(candidate.dot), Matches: make([]Match, 0, maxMatches)})
		}
		group := &groups[index]
		if len(group.Matches) == maxMatches {
			continue
		}
		group.Matches = append(group.Matches, Match{Scope: candidate.scope, English: candidate.english, Chinese: candidate.chinese, Location: candidate.location, Score: score(candidate.dot)})
	}
	if offset >= len(groups) {
		return Page{Groups: []Group{}}
	}
	end := offset + limit
	if end > len(groups) {
		end = len(groups)
	}
	page := Page{Groups: groups[offset:end]}
	if end < len(groups) {
		page.HasMore, page.NextOffset = true, end
	}
	return page
}

func score(dot int32) float32 { return float32(dot) / (127 * 127) }
