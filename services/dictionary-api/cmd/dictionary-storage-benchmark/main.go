// dictionary-storage-benchmark compares reproducible runtime storage layouts.
package main

import (
	"context"
	"database/sql"
	"encoding/csv"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"dictionary-api/internal/importer"
	"dictionary-api/internal/payload"
	"dictionary-api/internal/schema"
	_ "modernc.org/sqlite"
)

type result struct {
	Entries            int     `json:"entries"`
	SourceBytes        int64   `json:"source_bytes"`
	PageSize           int     `json:"page_size"`
	CompressionLevel   int     `json:"compression_level"`
	DictionaryBytes    int     `json:"dictionary_bytes"`
	DatabaseBytes      int64   `json:"database_bytes"`
	PayloadBytes       int64   `json:"payload_bytes"`
	ImportSeconds      float64 `json:"import_seconds"`
	ImportMiBPerSecond float64 `json:"import_mib_per_second"`
	QueryP50Micros     float64 `json:"query_p50_micros"`
	QueryP95Micros     float64 `json:"query_p95_micros"`
	DecodeP50Micros    float64 `json:"decode_p50_micros"`
	DecodeP95Micros    float64 `json:"decode_p95_micros"`
	EndToEndP50Micros  float64 `json:"query_decode_p50_micros"`
	EndToEndP95Micros  float64 `json:"query_decode_p95_micros"`
	PageCount          int     `json:"page_count"`
	FreelistPages      int     `json:"freelist_pages"`
}

func main() {
	var sourcePath, runtimeSourcePath, outputDir string
	var pageSizes, levels, dictionarySizes string
	var sourceVersion string
	var querySamples, maxEntries int
	var keepDatabases bool
	flag.StringVar(&sourcePath, "source", "", "original source SQLite database (oxford_x_word table)")
	flag.StringVar(&runtimeSourcePath, "runtime-source", "", "existing generated runtime SQLite database used to reconstruct an isolated benchmark source")
	flag.StringVar(&outputDir, "output", "", "directory for benchmark results and transient databases")
	flag.StringVar(&sourceVersion, "source-version", "benchmark", "source version stored in generated candidates")
	flag.StringVar(&pageSizes, "page-sizes", "4096,8192,16384", "comma-separated SQLite page sizes")
	flag.StringVar(&levels, "levels", "3,7,15,19", "comma-separated zstd compression levels")
	flag.StringVar(&dictionarySizes, "dictionary-sizes", "65536,131072", "comma-separated trained dictionary byte sizes")
	flag.IntVar(&querySamples, "query-samples", 5000, "random lookup/decode observations per candidate")
	flag.IntVar(&maxEntries, "max-entries", 0, "limit staged source rows for a fast validation run; zero means all rows")
	flag.BoolVar(&keepDatabases, "keep-databases", false, "keep generated candidate databases in the output directory")
	flag.Parse()

	if (sourcePath == "") == (runtimeSourcePath == "") {
		fatal(errors.New("provide exactly one of -source or -runtime-source"))
	}
	if outputDir == "" || querySamples < 1 || maxEntries < 0 {
		fatal(errors.New("-output is required, -query-samples must be positive, and -max-entries cannot be negative"))
	}
	pages, err := parseInts(pageSizes)
	if err != nil {
		fatal(fmt.Errorf("parse -page-sizes: %w", err))
	}
	compressionLevels, err := parseInts(levels)
	if err != nil {
		fatal(fmt.Errorf("parse -levels: %w", err))
	}
	dictionaries, err := parseInts(dictionarySizes)
	if err != nil {
		fatal(fmt.Errorf("parse -dictionary-sizes: %w", err))
	}
	if err := os.MkdirAll(outputDir, 0o755); err != nil {
		fatal(err)
	}

	ctx := context.Background()
	stagedSource := filepath.Join(outputDir, "benchmark-source.db")
	if err := os.Remove(stagedSource); err != nil && !errors.Is(err, os.ErrNotExist) {
		fatal(err)
	}
	defer os.Remove(stagedSource)
	if runtimeSourcePath != "" {
		sourceVersion, err = stageRuntimeSource(ctx, runtimeSourcePath, stagedSource, maxEntries, sourceVersion)
	} else {
		err = stageOriginalSource(ctx, sourcePath, stagedSource, maxEntries)
	}
	if err != nil {
		fatal(fmt.Errorf("stage benchmark source: %w", err))
	}
	entries, sourceBytes, err := sourceStats(ctx, stagedSource)
	if err != nil {
		fatal(err)
	}
	if entries == 0 {
		fatal(errors.New("staged source has no entries"))
	}

	results := make([]result, 0, len(pages)*len(compressionLevels)*len(dictionaries))
	for _, pageSize := range pages {
		for _, level := range compressionLevels {
			for _, dictionarySize := range dictionaries {
				candidate := filepath.Join(outputDir, fmt.Sprintf("runtime-p%d-l%d-d%d.db", pageSize, level, dictionarySize))
				if err := os.Remove(candidate); err != nil && !errors.Is(err, os.ErrNotExist) {
					fatal(err)
				}
				started := time.Now()
				err := importer.Import(ctx, importer.Config{
					SourcePath: stagedSource, TargetPath: candidate, SourceVersion: sourceVersion,
					Storage: importer.StorageOptions{PageSize: pageSize, CompressionLevel: level, DictionarySize: dictionarySize},
				})
				elapsed := time.Since(started)
				if err != nil {
					fatal(fmt.Errorf("import p=%d l=%d d=%d: %w", pageSize, level, dictionarySize, err))
				}
				measured, err := measureCandidate(ctx, candidate, entries, sourceBytes, pageSize, level, dictionarySize, elapsed, querySamples)
				if err != nil {
					fatal(fmt.Errorf("measure p=%d l=%d d=%d: %w", pageSize, level, dictionarySize, err))
				}
				results = append(results, measured)
				if err := writeResults(outputDir, results); err != nil {
					fatal(err)
				}
				fmt.Printf("p=%d level=%d dict=%dKiB db=%.2fMiB import=%.2fs query p95=%.1fus decode p95=%.1fus\n", pageSize, level, dictionarySize/1024, float64(measured.DatabaseBytes)/(1024*1024), elapsed.Seconds(), measured.QueryP95Micros, measured.DecodeP95Micros)
				if !keepDatabases {
					if err := os.Remove(candidate); err != nil {
						fatal(err)
					}
				}
			}
		}
	}
}

func stageOriginalSource(ctx context.Context, inputPath, outputPath string, maxEntries int) error {
	input, err := sql.Open("sqlite", readOnlyDSN(inputPath))
	if err != nil {
		return err
	}
	defer input.Close()
	return copySource(ctx, input, outputPath, maxEntries)
}

func stageRuntimeSource(ctx context.Context, inputPath, outputPath string, maxEntries int, fallbackVersion string) (string, error) {
	input, err := sql.Open("sqlite", readOnlyDSN(inputPath))
	if err != nil {
		return "", err
	}
	defer input.Close()
	if err := schema.Validate(input); err != nil {
		return "", err
	}
	var sourceVersion string
	if err := input.QueryRowContext(ctx, `SELECT value FROM dictionary_metadata WHERE key = 'source_version'`).Scan(&sourceVersion); err != nil || sourceVersion == "" {
		sourceVersion = fallbackVersion
	}
	codecName, dictionary, err := schema.PayloadSettings(input)
	if err != nil {
		return "", err
	}
	codec, known, err := payload.ByName(codecName, dictionary)
	if err != nil || !known {
		return "", fmt.Errorf("unsupported runtime codec %q: %w", codecName, err)
	}
	terms, err := runtimeTerms(ctx, input)
	if err != nil {
		return "", err
	}
	output, err := sql.Open("sqlite", outputPath)
	if err != nil {
		return "", err
	}
	defer output.Close()
	if _, err := output.ExecContext(ctx, `CREATE TABLE oxford_x_word (id TEXT PRIMARY KEY, word TEXT, word_body TEXT, word_search TEXT)`); err != nil {
		return "", err
	}
	tx, err := output.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	insert, err := tx.PrepareContext(ctx, `INSERT INTO oxford_x_word (id, word, word_body, word_search) VALUES (?, ?, ?, ?)`)
	if err != nil {
		return "", err
	}
	defer insert.Close()
	rows, err := input.QueryContext(ctx, `SELECT id, headword, payload, payload_size FROM entries ORDER BY id`)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	for count := 0; rows.Next(); count++ {
		if maxEntries > 0 && count >= maxEntries {
			break
		}
		var id, headword string
		var encoded []byte
		var rawSize int64
		if err := rows.Scan(&id, &headword, &encoded, &rawSize); err != nil {
			return "", err
		}
		raw, err := codec.Decompress(encoded, rawSize)
		if err != nil {
			return "", fmt.Errorf("decode %q: %w", id, err)
		}
		search := alternateTerm(terms[id], canonicalize(headword))
		if _, err := insert.ExecContext(ctx, id, headword, string(raw), search); err != nil {
			return "", err
		}
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	return sourceVersion, tx.Commit()
}

func copySource(ctx context.Context, input *sql.DB, outputPath string, maxEntries int) error {
	output, err := sql.Open("sqlite", outputPath)
	if err != nil {
		return err
	}
	defer output.Close()
	if _, err := output.ExecContext(ctx, `CREATE TABLE oxford_x_word (id TEXT PRIMARY KEY, word TEXT, word_body TEXT, word_search TEXT)`); err != nil {
		return err
	}
	rows, err := input.QueryContext(ctx, `SELECT id, word, word_body, word_search FROM oxford_x_word ORDER BY id`)
	if err != nil {
		return err
	}
	defer rows.Close()
	tx, err := output.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	insert, err := tx.PrepareContext(ctx, `INSERT INTO oxford_x_word (id, word, word_body, word_search) VALUES (?, ?, ?, ?)`)
	if err != nil {
		return err
	}
	defer insert.Close()
	for count := 0; rows.Next(); count++ {
		if maxEntries > 0 && count >= maxEntries {
			break
		}
		var id, word, body, search sql.NullString
		if err := rows.Scan(&id, &word, &body, &search); err != nil {
			return err
		}
		if _, err := insert.ExecContext(ctx, id, word, body, search); err != nil {
			return err
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	return tx.Commit()
}

func runtimeTerms(ctx context.Context, db *sql.DB) (map[string][]string, error) {
	rows, err := db.QueryContext(ctx, `SELECT entry_id, term FROM entry_terms ORDER BY entry_id, term`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	terms := make(map[string][]string)
	for rows.Next() {
		var entryID, term string
		if err := rows.Scan(&entryID, &term); err != nil {
			return nil, err
		}
		terms[entryID] = append(terms[entryID], term)
	}
	return terms, rows.Err()
}

func alternateTerm(terms []string, canonicalHeadword string) string {
	for _, term := range terms {
		if term != canonicalHeadword {
			return term
		}
	}
	return ""
}

func sourceStats(ctx context.Context, sourcePath string) (int, int64, error) {
	db, err := sql.Open("sqlite", readOnlyDSN(sourcePath))
	if err != nil {
		return 0, 0, err
	}
	defer db.Close()
	var entries int
	var bytes sql.NullInt64
	err = db.QueryRowContext(ctx, `SELECT COUNT(*), SUM(length(CAST(word_body AS BLOB))) FROM oxford_x_word`).Scan(&entries, &bytes)
	return entries, bytes.Int64, err
}

func measureCandidate(ctx context.Context, path string, entries int, sourceBytes int64, pageSize, level, dictionarySize int, importDuration time.Duration, samples int) (result, error) {
	info, err := os.Stat(path)
	if err != nil {
		return result{}, err
	}
	db, err := sql.Open("sqlite", readOnlyDSN(path))
	if err != nil {
		return result{}, err
	}
	defer db.Close()
	codecName, dictionary, err := schema.PayloadSettings(db)
	if err != nil {
		return result{}, err
	}
	codec, known, err := payload.ByName(codecName, dictionary)
	if err != nil || !known {
		return result{}, fmt.Errorf("payload codec %q: %w", codecName, err)
	}
	rows, err := db.QueryContext(ctx, `SELECT id FROM entries ORDER BY id`)
	if err != nil {
		return result{}, err
	}
	ids := make([]string, 0, entries)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return result{}, err
		}
		ids = append(ids, id)
	}
	if err := rows.Close(); err != nil {
		return result{}, err
	}
	if len(ids) == 0 {
		return result{}, errors.New("candidate has no entries")
	}
	statement, err := db.PrepareContext(ctx, `SELECT payload, payload_size FROM entries WHERE id = ?`)
	if err != nil {
		return result{}, err
	}
	defer statement.Close()
	queryDurations := make([]time.Duration, 0, samples)
	decodeDurations := make([]time.Duration, 0, samples)
	totalDurations := make([]time.Duration, 0, samples)
	state := uint64(0x9e3779b97f4a7c15)
	nextID := func() string {
		state ^= state << 7
		state ^= state >> 9
		return ids[int(state%uint64(len(ids)))]
	}
	for warmup := 0; warmup < min(samples, 512); warmup++ {
		var encoded []byte
		var rawSize int64
		if err := statement.QueryRowContext(ctx, nextID()).Scan(&encoded, &rawSize); err != nil {
			return result{}, err
		}
		if _, err := codec.Decompress(encoded, rawSize); err != nil {
			return result{}, err
		}
	}
	for observation := 0; observation < samples; observation++ {
		id := nextID()
		queryStarted := time.Now()
		var encoded []byte
		var rawSize int64
		for repeat := 0; repeat < 16; repeat++ {
			if err := statement.QueryRowContext(ctx, id).Scan(&encoded, &rawSize); err != nil {
				return result{}, err
			}
		}
		queryDuration := time.Since(queryStarted) / 16
		decodeStarted := time.Now()
		for repeat := 0; repeat < 16; repeat++ {
			if _, err := codec.Decompress(encoded, rawSize); err != nil {
				return result{}, err
			}
		}
		decodeDuration := time.Since(decodeStarted) / 16
		queryDurations = append(queryDurations, queryDuration)
		decodeDurations = append(decodeDurations, decodeDuration)
		totalDurations = append(totalDurations, queryDuration+decodeDuration)
	}
	var payloadBytes int64
	var pageCount, freelist int
	if err := db.QueryRowContext(ctx, `SELECT COALESCE(SUM(length(payload)), 0) FROM entries`).Scan(&payloadBytes); err != nil {
		return result{}, err
	}
	if err := db.QueryRowContext(ctx, `PRAGMA page_count`).Scan(&pageCount); err != nil {
		return result{}, err
	}
	if err := db.QueryRowContext(ctx, `PRAGMA freelist_count`).Scan(&freelist); err != nil {
		return result{}, err
	}
	throughput := 0.0
	if importDuration > 0 {
		throughput = float64(sourceBytes) / (1024 * 1024) / importDuration.Seconds()
	}
	return result{
		Entries: entries, SourceBytes: sourceBytes, PageSize: pageSize, CompressionLevel: level, DictionaryBytes: dictionarySize,
		DatabaseBytes: info.Size(), PayloadBytes: payloadBytes, ImportSeconds: importDuration.Seconds(), ImportMiBPerSecond: throughput,
		QueryP50Micros: percentileMicros(queryDurations, 0.50), QueryP95Micros: percentileMicros(queryDurations, 0.95),
		DecodeP50Micros: percentileMicros(decodeDurations, 0.50), DecodeP95Micros: percentileMicros(decodeDurations, 0.95),
		EndToEndP50Micros: percentileMicros(totalDurations, 0.50), EndToEndP95Micros: percentileMicros(totalDurations, 0.95),
		PageCount: pageCount, FreelistPages: freelist,
	}, nil
}

func writeResults(outputDir string, results []result) error {
	jsonBytes, err := json.MarshalIndent(results, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(outputDir, "results.json"), append(jsonBytes, '\n'), 0o644); err != nil {
		return err
	}
	file, err := os.Create(filepath.Join(outputDir, "results.csv"))
	if err != nil {
		return err
	}
	defer file.Close()
	writer := csv.NewWriter(file)
	defer writer.Flush()
	if err := writer.Write([]string{"page_size", "level", "dictionary_bytes", "database_bytes", "payload_bytes", "import_seconds", "import_mib_per_second", "query_p50_micros", "query_p95_micros", "decode_p50_micros", "decode_p95_micros", "query_decode_p50_micros", "query_decode_p95_micros", "page_count", "freelist_pages"}); err != nil {
		return err
	}
	for _, item := range results {
		if err := writer.Write([]string{strconv.Itoa(item.PageSize), strconv.Itoa(item.CompressionLevel), strconv.Itoa(item.DictionaryBytes), strconv.FormatInt(item.DatabaseBytes, 10), strconv.FormatInt(item.PayloadBytes, 10), fmt.Sprintf("%.6f", item.ImportSeconds), fmt.Sprintf("%.3f", item.ImportMiBPerSecond), fmt.Sprintf("%.3f", item.QueryP50Micros), fmt.Sprintf("%.3f", item.QueryP95Micros), fmt.Sprintf("%.3f", item.DecodeP50Micros), fmt.Sprintf("%.3f", item.DecodeP95Micros), fmt.Sprintf("%.3f", item.EndToEndP50Micros), fmt.Sprintf("%.3f", item.EndToEndP95Micros), strconv.Itoa(item.PageCount), strconv.Itoa(item.FreelistPages)}); err != nil {
			return err
		}
	}
	return writer.Error()
}

func parseInts(value string) ([]int, error) {
	parts := strings.Split(value, ",")
	values := make([]int, 0, len(parts))
	seen := make(map[int]struct{}, len(parts))
	for _, part := range parts {
		parsed, err := strconv.Atoi(strings.TrimSpace(part))
		if err != nil || parsed <= 0 {
			return nil, fmt.Errorf("%q is not a positive integer", part)
		}
		if _, exists := seen[parsed]; !exists {
			values = append(values, parsed)
			seen[parsed] = struct{}{}
		}
	}
	if len(values) == 0 {
		return nil, errors.New("no values supplied")
	}
	return values, nil
}

func percentileMicros(values []time.Duration, percentile float64) float64 {
	sorted := append([]time.Duration(nil), values...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	index := int(float64(len(sorted)-1) * percentile)
	return float64(sorted[index]) / float64(time.Microsecond)
}

func canonicalize(value string) string {
	return strings.ToLower(strings.ReplaceAll(strings.TrimSpace(value), "·", ""))
}
func readOnlyDSN(path string) string { return "file:" + filepath.ToSlash(path) + "?mode=ro" }
func min(left, right int) int {
	if left < right {
		return left
	}
	return right
}
func fatal(err error) { fmt.Fprintln(os.Stderr, "dictionary-storage-benchmark:", err); os.Exit(1) }
