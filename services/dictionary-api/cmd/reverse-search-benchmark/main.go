package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"dictionary-api/internal/reversesearch"
)

type queryResult struct {
	Query     string  `json:"query"`
	Matches   int     `json:"matches"`
	P50Millis float64 `json:"p50Millis"`
	P95Millis float64 `json:"p95Millis"`
	P99Millis float64 `json:"p99Millis"`
}

func main() {
	dictionaryPath := flag.String("db", "./data/dictionary.db", "path to the runtime dictionary database")
	sidecarPath := flag.String("reverse-search-db", "./data/reverse-search.db", "path to the reverse-search sidecar")
	queryList := flag.String("queries", "书,学校,记录,休息,短暂的休息,火山矽肺病,完全受某人控制", "comma-separated benchmark queries")
	iterations := flag.Int("iterations", 100, "measured iterations per query")
	limit := flag.Int("limit", 20, "result limit")
	flag.Parse()
	if *iterations < 1 || *iterations > 10_000 || *limit < 1 || *limit > 512 {
		fmt.Fprintln(os.Stderr, "iterations must be in 1..10000 and limit in 1..512")
		os.Exit(2)
	}
	fingerprint, err := reversesearch.FileSHA256(*dictionaryPath)
	if err != nil {
		fatal(err)
	}
	store, err := reversesearch.Open(*sidecarPath, fingerprint)
	if err != nil {
		fatal(err)
	}
	defer store.Close()

	ctx := context.Background()
	results := make([]queryResult, 0)
	for _, query := range strings.Split(*queryList, ",") {
		query = strings.TrimSpace(query)
		if query == "" {
			continue
		}
		if _, err := store.Search(ctx, query, *limit); err != nil {
			fatal(err)
		}
		durations := make([]time.Duration, *iterations)
		matches := 0
		for index := range durations {
			started := time.Now()
			groups, err := store.Search(ctx, query, *limit)
			durations[index] = time.Since(started)
			if err != nil {
				fatal(err)
			}
			matches = len(groups)
		}
		sort.Slice(durations, func(left, right int) bool { return durations[left] < durations[right] })
		results = append(results, queryResult{
			Query: query, Matches: matches,
			P50Millis: milliseconds(percentile(durations, .50)),
			P95Millis: milliseconds(percentile(durations, .95)),
			P99Millis: milliseconds(percentile(durations, .99)),
		})
	}
	if err := json.NewEncoder(os.Stdout).Encode(struct {
		Iterations int           `json:"iterations"`
		Limit      int           `json:"limit"`
		Queries    []queryResult `json:"queries"`
	}{Iterations: *iterations, Limit: *limit, Queries: results}); err != nil {
		fatal(err)
	}
}

func percentile(values []time.Duration, fraction float64) time.Duration {
	index := int(float64(len(values)-1) * fraction)
	return values[index]
}

func milliseconds(value time.Duration) float64 {
	return float64(value.Microseconds()) / 1000
}

func fatal(err error) {
	fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}
