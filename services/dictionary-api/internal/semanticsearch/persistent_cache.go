package semanticsearch

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// PersistentVectorCache is an optional, best-effort cache for normalized query vectors.
// Implementations must never make semantic search unavailable when a cache operation fails.
type PersistentVectorCache interface {
	Get(context.Context, string) ([]float32, bool)
	Put(context.Context, string, []float32)
}

type PersistentVectorCacheConfig struct {
	Path           string
	Key            []byte
	ModelKey       string
	Dimensions     int
	QueryTemplate  string
	QueryExtraJSON []byte
	MaxEntries     int
	TTL            time.Duration
	Now            func() time.Time
}

// SQLitePersistentVectorCache stores only a keyed HMAC and its vector. Queries are never
// written to disk; the HMAC namespace includes the complete embedding request contract.
type SQLitePersistentVectorCache struct {
	mu         sync.Mutex
	db         *sql.DB
	key        []byte
	namespace  []byte
	dimensions int
	maxEntries int
	ttl        time.Duration
	now        func() time.Time
}

func NewSQLitePersistentVectorCache(config PersistentVectorCacheConfig) (*SQLitePersistentVectorCache, error) {
	if strings.TrimSpace(config.Path) == "" || len(config.Key) == 0 {
		return nil, errors.New("persistent semantic cache path and key are required")
	}
	if len(config.Key) < 32 {
		return nil, errors.New("persistent semantic cache key must contain at least 32 bytes")
	}
	if strings.TrimSpace(config.ModelKey) == "" || config.Dimensions < 1 || config.MaxEntries < 1 || config.TTL <= 0 {
		return nil, errors.New("persistent semantic cache configuration is invalid")
	}
	if err := validateQueryTemplate(config.QueryTemplate); err != nil {
		return nil, fmt.Errorf("persistent semantic cache query template: %w", err)
	}
	if err := validateQueryExtraJSON(config.QueryExtraJSON); err != nil {
		return nil, fmt.Errorf("persistent semantic cache query options: %w", err)
	}
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(config.Path))
	if err != nil {
		return nil, fmt.Errorf("open persistent semantic cache: %w", err)
	}
	db.SetMaxOpenConns(1)
	if err := initializePersistentCache(db); err != nil {
		_ = db.Close()
		return nil, err
	}
	now := config.Now
	if now == nil {
		now = time.Now
	}
	return &SQLitePersistentVectorCache{
		db: db, key: append([]byte(nil), config.Key...),
		namespace:  cacheNamespace(config.ModelKey, config.Dimensions, config.QueryTemplate, config.QueryExtraJSON),
		dimensions: config.Dimensions, maxEntries: config.MaxEntries, ttl: config.TTL, now: now,
	}, nil
}

func initializePersistentCache(db *sql.DB) error {
	for _, statement := range []string{
		"PRAGMA journal_mode = WAL",
		"PRAGMA synchronous = NORMAL",
		"PRAGMA busy_timeout = 5000",
		`CREATE TABLE IF NOT EXISTS query_vectors (
			cache_key BLOB PRIMARY KEY,
			vector BLOB NOT NULL,
			created_at INTEGER NOT NULL,
			accessed_at INTEGER NOT NULL
		)`,
		"CREATE INDEX IF NOT EXISTS query_vectors_accessed_at ON query_vectors(accessed_at)",
	} {
		if _, err := db.Exec(statement); err != nil {
			return fmt.Errorf("initialize persistent semantic cache: %w", err)
		}
	}
	return nil
}

func (c *SQLitePersistentVectorCache) Get(ctx context.Context, query string) ([]float32, bool) {
	if c == nil {
		return nil, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.db == nil {
		return nil, false
	}
	key := c.cacheKey(query)
	var vectorBytes []byte
	var createdAt int64
	if err := c.db.QueryRowContext(ctx, "SELECT vector, created_at FROM query_vectors WHERE cache_key = ?", key).Scan(&vectorBytes, &createdAt); err != nil {
		return nil, false
	}
	now := c.now().UnixMilli()
	if createdAt <= now-c.ttl.Milliseconds() {
		_, _ = c.db.ExecContext(context.Background(), "DELETE FROM query_vectors WHERE cache_key = ?", key)
		return nil, false
	}
	vector, err := decodeCachedVector(vectorBytes, c.dimensions)
	if err == nil {
		vector, err = normalizeEmbedding(vector)
	}
	if err != nil {
		_, _ = c.db.ExecContext(context.Background(), "DELETE FROM query_vectors WHERE cache_key = ?", key)
		return nil, false
	}
	_, _ = c.db.ExecContext(context.Background(), "UPDATE query_vectors SET accessed_at = ? WHERE cache_key = ?", now, key)
	return vector, true
}

func (c *SQLitePersistentVectorCache) Put(ctx context.Context, query string, vector []float32) {
	if c == nil || len(vector) != c.dimensions {
		return
	}
	encoded, err := encodeCachedVector(vector)
	if err != nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.db == nil {
		return
	}
	now := c.now().UnixMilli()
	key := c.cacheKey(query)
	tx, err := c.db.BeginTx(ctx, nil)
	if err != nil {
		return
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	if _, err = tx.ExecContext(ctx, "DELETE FROM query_vectors WHERE created_at <= ?", now-c.ttl.Milliseconds()); err != nil {
		return
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO query_vectors(cache_key, vector, created_at, accessed_at) VALUES (?, ?, ?, ?)
		ON CONFLICT(cache_key) DO UPDATE SET vector = excluded.vector, created_at = excluded.created_at, accessed_at = excluded.accessed_at`, key, encoded, now, now); err != nil {
		return
	}
	var count int
	if err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM query_vectors").Scan(&count); err != nil {
		return
	}
	if excess := count - c.maxEntries; excess > 0 {
		if _, err = tx.ExecContext(ctx, "DELETE FROM query_vectors WHERE cache_key IN (SELECT cache_key FROM query_vectors ORDER BY accessed_at, created_at, cache_key LIMIT ?)", excess); err != nil {
			return
		}
	}
	if err = tx.Commit(); err == nil {
		committed = true
	}
}

func (c *SQLitePersistentVectorCache) Close() error {
	if c == nil {
		return nil
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.db == nil {
		return nil
	}
	err := c.db.Close()
	c.db = nil
	return err
}

func (c *SQLitePersistentVectorCache) cacheKey(query string) []byte {
	mac := hmac.New(sha256.New, c.key)
	_, _ = mac.Write(c.namespace)
	_, _ = mac.Write([]byte{0})
	_, _ = mac.Write([]byte(query))
	return mac.Sum(nil)
}

func cacheNamespace(modelKey string, dimensions int, queryTemplate string, queryExtraJSON []byte) []byte {
	return []byte(fmt.Sprintf("semantic-query-vector-cache-v1\x00%s\x00%d\x00%s\x00%s", modelKey, dimensions, queryTemplate, queryExtraJSON))
}

func encodeCachedVector(vector []float32) ([]byte, error) {
	encoded := make([]byte, len(vector)*4)
	for index, value := range vector {
		if math.IsNaN(float64(value)) || math.IsInf(float64(value), 0) {
			return nil, errors.New("non-finite vector")
		}
		binary.LittleEndian.PutUint32(encoded[index*4:], math.Float32bits(value))
	}
	return encoded, nil
}

func decodeCachedVector(encoded []byte, dimensions int) ([]float32, error) {
	if len(encoded) != dimensions*4 {
		return nil, errors.New("cached vector shape is invalid")
	}
	vector := make([]float32, dimensions)
	for index := range vector {
		vector[index] = math.Float32frombits(binary.LittleEndian.Uint32(encoded[index*4:]))
		if math.IsNaN(float64(vector[index])) || math.IsInf(float64(vector[index]), 0) {
			return nil, errors.New("cached vector is non-finite")
		}
	}
	return vector, nil
}
