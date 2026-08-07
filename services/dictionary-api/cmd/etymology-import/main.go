package main

import (
	"context"
	"flag"
	"log"
	"os"

	"dictionary-api/internal/etymology"
)

func main() {
	source := flag.String("source", envOr("DICTIONARY_ETYMOLOGY_SOURCE_DB_PATH", "./work/etymonline-data/vocabulary.db"), "source Etymonline SQLite database")
	target := flag.String("target", envOr("DICTIONARY_ETYMOLOGY_DB_PATH", "./data/etymology.db"), "generated Etymonline sidecar database")
	version := flag.String("source-version", envOr("DICTIONARY_ETYMOLOGY_SOURCE_VERSION", "etymonline-v1"), "source version stored in the sidecar")
	replace := flag.Bool("replace", false, "replace an existing target database")
	pageSize := flag.Int("page-size", 8*1024, "SQLite page size for a newly generated sidecar")
	compressionLevel := flag.Int("compression-level", 7, "zstd compression level for independently stored article payloads")
	dictionarySize := flag.Int("dictionary-size", 64*1024, "trained zstd dictionary size in bytes")
	flag.Parse()

	if err := etymology.Import(context.Background(), etymology.ImportConfig{
		SourcePath: *source, TargetPath: *target, SourceVersion: *version, Replace: *replace,
		Storage: etymology.StorageOptions{PageSize: *pageSize, CompressionLevel: *compressionLevel, DictionarySize: *dictionarySize},
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
