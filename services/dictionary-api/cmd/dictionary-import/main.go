package main

import (
	"context"
	"flag"
	"log"
	"os"

	"dictionary-api/internal/importer"
)

func main() {
	source := flag.String("source", envOr("DICTIONARY_SOURCE_DB_PATH", "./data/source.db"), "source SQLite database")
	target := flag.String("target", envOr("DICTIONARY_RUNTIME_DB_PATH", "./data/dictionary.db"), "generated runtime SQLite database")
	version := flag.String("source-version", envOr("DICTIONARY_SOURCE_VERSION", "bundled-v1"), "source version stored in the runtime database")
	replace := flag.Bool("replace", false, "replace an existing target database")
	pageSize := flag.Int("page-size", 8*1024, "SQLite page size for a newly generated runtime database")
	compressionLevel := flag.Int("compression-level", 7, "zstd compression level for independently stored payloads")
	dictionarySize := flag.Int("dictionary-size", 64*1024, "trained zstd dictionary size in bytes")
	flag.Parse()
	if err := importer.Import(context.Background(), importer.Config{
		SourcePath: *source, TargetPath: *target, SourceVersion: *version, Replace: *replace,
		Storage: importer.StorageOptions{PageSize: *pageSize, CompressionLevel: *compressionLevel, DictionarySize: *dictionarySize},
	}); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
