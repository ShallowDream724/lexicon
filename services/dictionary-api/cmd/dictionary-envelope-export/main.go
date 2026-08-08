package main

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"

	"dictionary-api/internal/payload"
	"dictionary-api/internal/runtimeentry"
	"dictionary-api/internal/schema"
	_ "modernc.org/sqlite"
)

func main() {
	databasePath := flag.String("db", "./data/dictionary.db", "path to the runtime dictionary database")
	flag.Parse()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	if err := export(ctx, *databasePath); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func export(ctx context.Context, databasePath string) error {
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(databasePath)+"?mode=ro")
	if err != nil {
		return err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if err := db.PingContext(ctx); err != nil {
		return fmt.Errorf("open runtime database: %w", err)
	}
	if err := schema.Validate(db); err != nil {
		return err
	}
	sourceVersion, err := schema.SourceVersion(db)
	if err != nil {
		return err
	}
	codecName, dictionary, err := schema.PayloadSettings(db)
	if err != nil {
		return err
	}
	codec, known, err := payload.ByName(codecName, dictionary)
	if err != nil {
		return fmt.Errorf("initialize runtime payload codec %q: %w", codecName, err)
	}
	if !known {
		return fmt.Errorf("unsupported runtime payload codec %q", codecName)
	}

	output := bufio.NewWriterSize(os.Stdout, 1<<20)
	encoder := json.NewEncoder(output)
	encoder.SetEscapeHTML(false)
	reader := runtimeentry.NewReader(db, codec, sourceVersion)
	if err := reader.Walk(ctx, func(envelope runtimeentry.Envelope) error {
		return encoder.Encode(envelope)
	}); err != nil {
		return err
	}
	return output.Flush()
}
