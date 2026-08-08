package main

import (
	"context"
	"database/sql"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"

	"dictionary-api/internal/reversesearch"
	"dictionary-api/internal/schema"
	_ "modernc.org/sqlite"
)

func main() {
	dictionaryPath := flag.String("db", "./data/dictionary.db", "path to the runtime dictionary database")
	targetPath := flag.String("output", "./data/reverse-search.db", "path for the generated reverse-search sidecar")
	replace := flag.Bool("replace", false, "replace an existing sidecar")
	pageSize := flag.Int("page-size", 8192, "SQLite page size")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	sourceVersion, err := dictionarySourceVersion(ctx, *dictionaryPath)
	if err == nil {
		err = reversesearch.Import(ctx, reversesearch.ImportConfig{
			Documents:         os.Stdin,
			DictionaryPath:    *dictionaryPath,
			TargetPath:        *targetPath,
			SourceVersion:     sourceVersion,
			ProjectionVersion: reversesearch.ProjectionVersion,
			Replace:           *replace,
			PageSize:          *pageSize,
		})
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func dictionarySourceVersion(ctx context.Context, path string) (string, error) {
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path)+"?mode=ro")
	if err != nil {
		return "", err
	}
	defer db.Close()
	if err := db.PingContext(ctx); err != nil {
		return "", fmt.Errorf("open runtime database: %w", err)
	}
	if err := schema.Validate(db); err != nil {
		return "", err
	}
	return schema.SourceVersion(db)
}
