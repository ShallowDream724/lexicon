package main

import (
	"context"
	"database/sql"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"

	"dictionary-api/internal/audio"
	"dictionary-api/internal/etymology"
	"dictionary-api/internal/media"
	"dictionary-api/internal/payload"
	"dictionary-api/internal/reversesearch"
	"dictionary-api/internal/schema"
	"dictionary-api/internal/semanticsearch"
	"dictionary-api/internal/server"
	_ "modernc.org/sqlite"
)

func main() {
	defaults := defaultConfig()
	dbPath := flag.String("db", defaults.dbPath, "path to the SQLite dictionary database")
	audioPath := flag.String("audio-zip", defaults.audioPath, "path to the headword audio ZIP")
	etymologyPath := flag.String("etymology-db", defaults.etymologyPath, "path to the optional Etymonline sidecar SQLite database")
	reverseSearchPath := flag.String("reverse-search-db", defaults.reverseSearchPath, "path to the optional Chinese reverse-search sidecar SQLite database")
	semanticSearchPath := flag.String("semantic-search-db", defaults.semanticSearchPath, "path to the optional semantic-search sidecar SQLite database")
	semanticBaseURL := flag.String("semantic-base-url", defaults.semanticBaseURL, "OpenAI-compatible semantic embedding base URL")
	semanticAPIKey := flag.String("semantic-api-key", defaults.semanticAPIKey, "semantic embedding API key")
	semanticModel := flag.String("semantic-model", defaults.semanticModel, "semantic embedding provider model")
	semanticModelKey := flag.String("semantic-model-key", defaults.semanticModelKey, "semantic sidecar model key")
	semanticTimeout := flag.String("semantic-timeout", defaults.semanticTimeout, "semantic embedding request timeout")
	semanticCache := flag.String("semantic-cache", defaults.semanticCache, "semantic search and query-vector cache capacity")
	semanticPersistentCache := flag.String("semantic-persistent-cache", defaults.semanticPersistentCache, "enable persistent semantic query-vector cache")
	semanticPersistentCachePath := flag.String("semantic-persistent-cache-path", defaults.semanticPersistentCachePath, "path to the persistent semantic query-vector cache SQLite database")
	semanticPersistentCacheKey := flag.String("semantic-persistent-cache-key", defaults.semanticPersistentCacheKey, "HMAC key for persistent semantic query-vector cache")
	semanticPersistentCacheMaxEntries := flag.String("semantic-persistent-cache-max-entries", defaults.semanticPersistentCacheMaxEntries, "maximum persistent semantic query-vector cache entries")
	semanticPersistentCacheTTL := flag.String("semantic-persistent-cache-ttl", defaults.semanticPersistentCacheTTL, "persistent semantic query-vector cache TTL")
	exampleAudioBaseURL := flag.String("example-audio-base-url", defaults.exampleAudioBaseURL, "base URL for example audio objects")
	illustrationBaseURL := flag.String("illustration-base-url", defaults.illustrationBaseURL, "base URL for illustration objects")
	illustrationURLTemplate := flag.String("illustration-url-template", defaults.illustrationURLTemplate, "URL template for full illustration objects")
	illustrationThumbnailURLTemplate := flag.String("illustration-thumbnail-url-template", defaults.illustrationThumbnailURLTemplate, "URL template for illustration thumbnails")
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
	var etymologyStore *etymology.Store
	if path := strings.TrimSpace(*etymologyPath); path != "" {
		etymologyStore, err = openOptionalEtymology(path)
		if err != nil {
			logger.Error("open etymology sidecar", "error", err)
			os.Exit(1)
		}
		if etymologyStore == nil {
			logger.Warn("optional etymology sidecar is unavailable", "path", path)
		}
	}
	dictionaryFingerprint := ""
	if strings.TrimSpace(*reverseSearchPath) != "" || strings.TrimSpace(*semanticSearchPath) != "" {
		dictionaryFingerprint, err = reversesearch.FileSHA256(*dbPath)
		if err != nil {
			logger.Error("fingerprint runtime dictionary", "error", err)
			os.Exit(1)
		}
	}
	var reverseSearchStore *reversesearch.Store
	if path := strings.TrimSpace(*reverseSearchPath); path != "" {
		reverseSearchStore, err = openOptionalReverseSearch(path, dictionaryFingerprint)
		if err != nil {
			logger.Error("open Chinese reverse-search sidecar", "error", err)
			os.Exit(1)
		}
		if reverseSearchStore == nil {
			logger.Warn("optional Chinese reverse-search sidecar is unavailable", "path", path)
		}
	}
	semanticEngine, semanticStore, err := openOptionalSemanticSearch(semanticRuntimeConfig{
		path: *semanticSearchPath, dictionaryFingerprint: dictionaryFingerprint, reverseSearchPath: *reverseSearchPath,
		baseURL: *semanticBaseURL, apiKey: *semanticAPIKey, model: *semanticModel, modelKey: *semanticModelKey,
		timeout: *semanticTimeout, cache: *semanticCache,
		persistentCache: *semanticPersistentCache, persistentCachePath: *semanticPersistentCachePath,
		persistentCacheKey: *semanticPersistentCacheKey, persistentCacheMaxEntries: *semanticPersistentCacheMaxEntries,
		persistentCacheTTL: *semanticPersistentCacheTTL,
		warn:               func(message string, err error) { logger.Warn(message, "error", err) },
	})
	if err != nil {
		logger.Warn("optional semantic-search capability is unavailable", "path", *semanticSearchPath, "error", err)
	}
	if strings.TrimSpace(*semanticSearchPath) != "" && semanticEngine == nil && err == nil {
		logger.Warn("optional semantic-search capability is unavailable", "path", *semanticSearchPath)
	}
	if semanticEngine != nil {
		defer semanticEngine.Close()
	}
	if semanticStore != nil {
		defer semanticStore.Close()
	}
	mediaResolver, err := media.NewResolverWithTemplates(map[media.Kind]string{
		media.ExampleAudio: *exampleAudioBaseURL,
		media.Illustration: *illustrationBaseURL,
	}, map[media.Kind]string{
		media.Illustration:          *illustrationURLTemplate,
		media.IllustrationThumbnail: *illustrationThumbnailURLTemplate,
	})
	if err != nil {
		logger.Error("configure remote media", "error", err)
		os.Exit(1)
	}
	service := server.New(db, audioIndex, server.Config{
		SourceVersion: sourceVersion, PayloadCodec: payloadCodec, RemoteMedia: mediaResolver,
		AllowedOrigins: parseOrigins(*origins), Logger: logger, Etymology: etymologyStore,
		ReverseSearch:  reverseSearchStore,
		SemanticSearch: semanticEngine,
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
	dbPath, audioPath, etymologyPath, reverseSearchPath, semanticSearchPath                          string
	exampleAudioBaseURL, illustrationBaseURL                                                         string
	illustrationURLTemplate, illustrationThumbnailURLTemplate                                        string
	listen, origins                                                                                  string
	semanticBaseURL, semanticAPIKey, semanticModel, semanticModelKey, semanticTimeout, semanticCache string
	semanticPersistentCache, semanticPersistentCachePath, semanticPersistentCacheKey                 string
	semanticPersistentCacheMaxEntries, semanticPersistentCacheTTL                                    string
}

func defaultConfig() configDefaults {
	return configDefaults{
		dbPath:                            envOr("DICTIONARY_RUNTIME_DB_PATH", "./data/dictionary.db"),
		audioPath:                         envOr("DICTIONARY_AUDIO_ZIP_PATH", ""),
		etymologyPath:                     envOr("DICTIONARY_ETYMOLOGY_DB_PATH", ""),
		reverseSearchPath:                 envOr("DICTIONARY_REVERSE_SEARCH_DB_PATH", ""),
		semanticSearchPath:                envOr("DICTIONARY_SEMANTIC_SEARCH_DB_PATH", ""),
		semanticBaseURL:                   envOr("DICTIONARY_SEMANTIC_BASE_URL", ""),
		semanticAPIKey:                    envOr("DICTIONARY_SEMANTIC_API_KEY", ""),
		semanticModel:                     envOr("DICTIONARY_SEMANTIC_MODEL", ""),
		semanticModelKey:                  envOr("DICTIONARY_SEMANTIC_MODEL_KEY", ""),
		semanticTimeout:                   envOr("DICTIONARY_SEMANTIC_TIMEOUT", "3s"),
		semanticCache:                     envOr("DICTIONARY_SEMANTIC_CACHE", "128"),
		semanticPersistentCache:           envOr("DICTIONARY_SEMANTIC_PERSISTENT_CACHE", "true"),
		semanticPersistentCachePath:       envOr("DICTIONARY_SEMANTIC_PERSISTENT_CACHE_PATH", ""),
		semanticPersistentCacheKey:        envOr("DICTIONARY_SEMANTIC_PERSISTENT_CACHE_KEY", ""),
		semanticPersistentCacheMaxEntries: envOr("DICTIONARY_SEMANTIC_PERSISTENT_CACHE_MAX_ENTRIES", "10000"),
		semanticPersistentCacheTTL:        envOr("DICTIONARY_SEMANTIC_PERSISTENT_CACHE_TTL", "720h"),
		exampleAudioBaseURL:               envOr("DICTIONARY_EXAMPLE_AUDIO_BASE_URL", ""),
		illustrationBaseURL:               envOr("DICTIONARY_ILLUSTRATION_BASE_URL", ""),
		illustrationURLTemplate:           envOr("DICTIONARY_ILLUSTRATION_URL_TEMPLATE", ""),
		illustrationThumbnailURLTemplate:  envOr("DICTIONARY_ILLUSTRATION_THUMBNAIL_URL_TEMPLATE", ""),
		listen:                            envOr("DICTIONARY_LISTEN", "127.0.0.1:8787"),
		origins:                           envOr("DICTIONARY_CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000"),
	}
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}

func openOptionalEtymology(path string) (*etymology.Store, error) {
	if _, err := os.Stat(path); err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("inspect etymology sidecar: %w", err)
	}
	return etymology.Open(path)
}

func openOptionalReverseSearch(path, dictionaryFingerprint string) (*reversesearch.Store, error) {
	if _, err := os.Stat(path); err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("inspect Chinese reverse-search sidecar: %w", err)
	}
	return reversesearch.Open(path, dictionaryFingerprint)
}

type semanticRuntimeConfig struct {
	path, dictionaryFingerprint, reverseSearchPath           string
	baseURL, apiKey, model, modelKey, timeout, cache         string
	persistentCache, persistentCachePath, persistentCacheKey string
	persistentCacheMaxEntries, persistentCacheTTL            string
	warn                                                     func(string, error)
}

func openOptionalSemanticSearch(config semanticRuntimeConfig) (*semanticsearch.Engine, *semanticsearch.Store, error) {
	path := strings.TrimSpace(config.path)
	if path == "" {
		return nil, nil, nil
	}
	if _, err := os.Stat(path); err != nil {
		if os.IsNotExist(err) {
			return nil, nil, nil
		}
		return nil, nil, fmt.Errorf("inspect semantic-search sidecar: %w", err)
	}
	missing := make([]string, 0, 5)
	for name, value := range map[string]string{
		"DICTIONARY_SEMANTIC_BASE_URL":  config.baseURL,
		"DICTIONARY_SEMANTIC_API_KEY":   config.apiKey,
		"DICTIONARY_SEMANTIC_MODEL":     config.model,
		"DICTIONARY_SEMANTIC_MODEL_KEY": config.modelKey,
	} {
		if strings.TrimSpace(value) == "" {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		slices.Sort(missing)
		return nil, nil, fmt.Errorf("semantic-search sidecar is present but provider configuration is incomplete: missing %s", strings.Join(missing, ", "))
	}
	if strings.TrimSpace(config.reverseSearchPath) == "" {
		return nil, nil, errors.New("semantic-search sidecar requires DICTIONARY_REVERSE_SEARCH_DB_PATH")
	}
	if _, err := os.Stat(config.reverseSearchPath); err != nil {
		return nil, nil, fmt.Errorf("inspect Chinese reverse-search sidecar: %w", err)
	}
	reverseFingerprint, err := reversesearch.FileSHA256(config.reverseSearchPath)
	if err != nil {
		return nil, nil, fmt.Errorf("fingerprint Chinese reverse-search sidecar: %w", err)
	}
	cacheCapacity, err := strconv.Atoi(strings.TrimSpace(config.cache))
	if err != nil || cacheCapacity < 0 {
		return nil, nil, fmt.Errorf("semantic cache must be a non-negative integer")
	}
	timeout, err := time.ParseDuration(strings.TrimSpace(config.timeout))
	if err != nil || timeout <= 0 {
		return nil, nil, fmt.Errorf("semantic timeout must be a positive duration")
	}
	store, err := semanticsearch.Open(path, config.dictionaryFingerprint, reverseFingerprint, semanticsearch.ProjectionVersion, config.modelKey)
	if err != nil {
		return nil, nil, err
	}
	embedder, err := semanticsearch.NewOpenAIEmbedder(semanticsearch.OpenAIEmbedderConfig{
		BaseURL: config.baseURL, APIKey: config.apiKey, Model: config.model, ModelKey: config.modelKey,
		Dimensions: store.Dimensions(), Timeout: timeout,
	})
	if err != nil {
		_ = store.Close()
		return nil, nil, err
	}
	persistentCache := openOptionalPersistentSemanticCache(config, store)
	engine, err := semanticsearch.NewEngineWithPersistentVectorCache(store, embedder, cacheCapacity, cacheCapacity, persistentCache)
	if err != nil {
		if closer, ok := persistentCache.(interface{ Close() error }); ok {
			_ = closer.Close()
		}
		_ = store.Close()
		return nil, nil, err
	}
	return engine, store, nil
}

func openOptionalPersistentSemanticCache(config semanticRuntimeConfig, store *semanticsearch.Store) semanticsearch.PersistentVectorCache {
	enabled := true
	if value := strings.TrimSpace(config.persistentCache); value != "" {
		parsed, err := strconv.ParseBool(value)
		if err != nil {
			warnSemantic(config, "persistent semantic query-vector cache is disabled", fmt.Errorf("persistent semantic cache enabled must be boolean: %w", err))
			return nil
		}
		enabled = parsed
	}
	if !enabled {
		return nil
	}
	cachePath := strings.TrimSpace(config.persistentCachePath)
	cacheKey := strings.TrimSpace(config.persistentCacheKey)
	if cachePath == "" && cacheKey == "" {
		return nil
	}
	if cachePath == "" || cacheKey == "" {
		warnSemantic(config, "persistent semantic query-vector cache is disabled", errors.New("persistent semantic cache path and key must be configured together"))
		return nil
	}
	maxEntries, err := strconv.Atoi(strings.TrimSpace(config.persistentCacheMaxEntries))
	if err != nil || maxEntries < 1 {
		warnSemantic(config, "persistent semantic query-vector cache is disabled", fmt.Errorf("persistent semantic cache maximum entries must be a positive integer"))
		return nil
	}
	ttl, err := time.ParseDuration(strings.TrimSpace(config.persistentCacheTTL))
	if err != nil || ttl <= 0 {
		warnSemantic(config, "persistent semantic query-vector cache is disabled", fmt.Errorf("persistent semantic cache TTL must be a positive duration"))
		return nil
	}
	cache, err := semanticsearch.NewSQLitePersistentVectorCache(semanticsearch.PersistentVectorCacheConfig{
		Path: cachePath, Key: []byte(cacheKey), ModelKey: store.ModelKey(),
		Dimensions: store.Dimensions(), QueryTemplate: store.QueryTemplate(), QueryExtraJSON: store.QueryExtraJSON(),
		MaxEntries: maxEntries, TTL: ttl,
	})
	if err != nil {
		warnSemantic(config, "persistent semantic query-vector cache is disabled", err)
		return nil
	}
	return cache
}

func warnSemantic(config semanticRuntimeConfig, message string, err error) {
	if config.warn != nil {
		config.warn(message, err)
	}
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
