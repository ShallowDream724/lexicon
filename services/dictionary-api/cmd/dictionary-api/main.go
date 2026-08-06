package main

import (
	"context"
	"database/sql"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"dictionary-api/internal/audio"
	"dictionary-api/internal/media"
	"dictionary-api/internal/payload"
	"dictionary-api/internal/schema"
	"dictionary-api/internal/server"
	_ "modernc.org/sqlite"
)

func main() {
	defaults := defaultConfig()
	dbPath := flag.String("db", defaults.dbPath, "path to the SQLite dictionary database")
	audioPath := flag.String("audio-zip", defaults.audioPath, "path to the headword audio ZIP")
	exampleAudioBaseURL := flag.String("example-audio-base-url", defaults.exampleAudioBaseURL, "base URL for example audio objects")
	illustrationBaseURL := flag.String("illustration-base-url", defaults.illustrationBaseURL, "base URL for illustration objects")
	listen := flag.String("listen", defaults.listen, "HTTP listen address")
	origins := flag.String("cors-origins", defaults.origins, "comma-separated allowed CORS origins")
	flag.Parse()

	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	db, err := sql.Open("sqlite", fmt.Sprintf("file:%s?mode=ro", *dbPath))
	if err != nil {
		logger.Error("open database", "error", err)
		os.Exit(1)
	}
	db.SetMaxOpenConns(4)
	db.SetConnMaxLifetime(0)
	if err := db.Ping(); err != nil {
		logger.Error("connect database", "error", err)
		os.Exit(1)
	}
	if err := schema.Validate(db); err != nil {
		logger.Error("validate runtime database", "error", err)
		os.Exit(1)
	}
	sourceVersion, err := schema.SourceVersion(db)
	if err != nil {
		logger.Error("read runtime metadata", "error", err)
		os.Exit(1)
	}
	codecName, dictionary, err := schema.PayloadSettings(db)
	if err != nil {
		logger.Error("read runtime payload settings", "error", err)
		os.Exit(1)
	}
	payloadCodec, known, err := payload.ByName(codecName, dictionary)
	if err != nil || !known {
		logger.Error("initialize runtime payload codec", "codec", codecName, "error", err)
		os.Exit(1)
	}
	var audioIndex *audio.Index
	if strings.TrimSpace(*audioPath) != "" {
		audioIndex, err = audio.Open(*audioPath)
		if err != nil {
			logger.Error("open audio archive", "error", err)
			os.Exit(1)
		}
	}
	mediaResolver, err := media.NewResolver(map[media.Kind]string{
		media.ExampleAudio: *exampleAudioBaseURL,
		media.Illustration: *illustrationBaseURL,
	})
	if err != nil {
		logger.Error("configure remote media", "error", err)
		os.Exit(1)
	}
	service := server.New(db, audioIndex, server.Config{
		SourceVersion: sourceVersion, PayloadCodec: payloadCodec, RemoteMedia: mediaResolver,
		AllowedOrigins: parseOrigins(*origins), Logger: logger,
	})
	defer service.Close()

	httpServer := &http.Server{
		Addr: *listen, Handler: service.Handler(),
		ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second,
		WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second,
	}
	go func() {
		logger.Info("dictionary API listening", "address", *listen)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logger.Error("HTTP server failed", "error", err)
			os.Exit(1)
		}
	}()
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := httpServer.Shutdown(ctx); err != nil {
		logger.Error("graceful shutdown failed", "error", err)
	}
}

type configDefaults struct {
	dbPath, audioPath, exampleAudioBaseURL, illustrationBaseURL, listen, origins string
}

func defaultConfig() configDefaults {
	return configDefaults{
		dbPath:              envOr("DICTIONARY_RUNTIME_DB_PATH", "./data/dictionary.db"),
		audioPath:           envOr("DICTIONARY_AUDIO_ZIP_PATH", ""),
		exampleAudioBaseURL: envOr("DICTIONARY_EXAMPLE_AUDIO_BASE_URL", ""),
		illustrationBaseURL: envOr("DICTIONARY_ILLUSTRATION_BASE_URL", ""),
		listen:              envOr("DICTIONARY_LISTEN", "127.0.0.1:8787"),
		origins:             envOr("DICTIONARY_CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000"),
	}
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func parseOrigins(value string) map[string]struct{} {
	origins := make(map[string]struct{})
	for _, origin := range strings.Split(value, ",") {
		if origin = strings.TrimSpace(origin); origin != "" {
			origins[origin] = struct{}{}
		}
	}
	return origins
}
