package server

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"dictionary-api/internal/audio"
	"dictionary-api/internal/media"
	"dictionary-api/internal/payload"
	"dictionary-api/internal/typo"
)

const (
	defaultLimit   = 20
	maxLimit       = 50
	maxEntrySize   = 16 << 20
	maxTypoMatches = 128
)

type requestIDContextKey struct{}

type Config struct {
	SourceVersion  string
	PayloadCodec   payload.Codec
	RemoteMedia    *media.Resolver
	AllowedOrigins map[string]struct{}
	Logger         *slog.Logger
}

type Service struct {
	db             *sql.DB
	audio          *audio.Index
	sourceVersion  string
	payloadCodec   payload.Codec
	remoteMedia    *media.Resolver
	allowedOrigins map[string]struct{}
	logger         *slog.Logger
}

func New(db *sql.DB, audioIndex *audio.Index, config Config) *Service {
	logger := config.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &Service{
		db: db, audio: audioIndex, sourceVersion: config.SourceVersion,
		payloadCodec:   config.PayloadCodec,
		remoteMedia:    config.RemoteMedia,
		allowedOrigins: config.AllowedOrigins, logger: logger,
	}
}

func (s *Service) Close() error {
	var errs []error
	if s.audio != nil {
		errs = append(errs, s.audio.Close())
	}
	if s.db != nil {
		errs = append(errs, s.db.Close())
	}
	return errors.Join(errs...)
}

func (s *Service) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/health", s.health)
	mux.HandleFunc("GET /api/v1/search", s.search)
	mux.HandleFunc("GET /api/v1/entries/{id}", s.entry)
	mux.HandleFunc("GET /api/v1/media/headword-audio", s.headwordAudio)
	mux.HandleFunc("GET /api/v1/media/example-audio", s.remoteMediaRedirect(media.ExampleAudio))
	mux.HandleFunc("GET /api/v1/media/illustration", s.illustration)
	return s.withRequestID(s.withCORS(s.withLogging(mux)))
}

func (s *Service) health(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.db.PingContext(ctx); err != nil {
		s.writeError(w, r, http.StatusServiceUnavailable, "database_unavailable", "dictionary database is unavailable")
		return
	}
	s.writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "source_version": s.sourceVersion})
}

type suggestion struct {
	ID                 string   `json:"id"`
	Headword           string   `json:"headword"`
	PartsOfSpeech      []string `json:"partsOfSpeech"`
	TranslationPreview string   `json:"translationPreview"`
}

func (s *Service) search(w http.ResponseWriter, r *http.Request) {
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" {
		s.writeError(w, r, http.StatusBadRequest, "invalid_query", "q must not be empty")
		return
	}
	if len([]rune(query)) > 200 {
		s.writeError(w, r, http.StatusBadRequest, "invalid_query", "q must be 200 characters or fewer")
		return
	}
	limit, err := parseLimit(r.URL.Query().Get("limit"))
	if err != nil {
		s.writeError(w, r, http.StatusBadRequest, "invalid_limit", err.Error())
		return
	}

	canonical := strings.ToLower(strings.ReplaceAll(query, "·", ""))
	results, err := s.queryPrefixSuggestions(r.Context(), canonical, limit)
	if err != nil {
		s.logger.Error("dictionary search failed", "error", err)
		s.writeError(w, r, http.StatusInternalServerError, "search_failed", "search could not be completed")
		return
	}
	if len(results) == 0 && typo.Eligible(canonical) {
		results, err = s.queryTypoSuggestions(r.Context(), canonical, limit)
		if err != nil {
			s.logger.Error("dictionary typo search failed", "error", err)
			s.writeError(w, r, http.StatusInternalServerError, "search_failed", "search could not be completed")
			return
		}
	}
	s.writeJSON(w, http.StatusOK, struct {
		Query string       `json:"query"`
		Items []suggestion `json:"items"`
	}{Query: query, Items: results})
}

func (s *Service) queryPrefixSuggestions(ctx context.Context, canonical string, limit int) ([]suggestion, error) {
	prefixEnd := canonical + string(rune(0x10ffff))
	const statement = `
	WITH matches AS (
	  SELECT t.entry_id, MIN(CASE WHEN t.term = ? THEN 0 ELSE 1 END) AS exact_rank
	  FROM entry_terms t
	  WHERE t.term >= ? AND t.term < ?
	  GROUP BY t.entry_id
	)
	SELECT e.id, e.headword, e.parts_of_speech, e.translation_preview
	FROM matches m
	JOIN entries e ON e.id = m.entry_id
	ORDER BY
	  m.exact_rank,
	  e.headword COLLATE NOCASE ASC,
	  e.id ASC
	LIMIT ?`
	rows, err := s.db.QueryContext(ctx, statement, canonical, canonical, prefixEnd, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	results := make([]suggestion, 0, limit)
	for rows.Next() {
		var item suggestion
		var partsOfSpeech string
		if err := rows.Scan(&item.ID, &item.Headword, &partsOfSpeech, &item.TranslationPreview); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(partsOfSpeech), &item.PartsOfSpeech); err != nil || item.PartsOfSpeech == nil {
			s.logger.Error("dictionary search projection is malformed", "id", item.ID, "error", err)
			return nil, errors.New("dictionary search projection is malformed")
		}
		results = append(results, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return results, nil
}

type typoCandidate struct {
	entryID string
	rank    int
}

func (s *Service) queryTypoSuggestions(ctx context.Context, canonical string, limit int) ([]suggestion, error) {
	candidates := make(map[string]int, maxTypoMatches)
	directTerms := typo.DirectCandidates(canonical)
	if err := s.collectDirectTypoCandidates(ctx, directTerms, candidates); err != nil {
		return nil, err
	}
	for index, signature := range typo.SearchSignatures(canonical) {
		if len(candidates) == maxTypoMatches {
			break
		}
		remaining := maxTypoMatches - len(candidates)
		rows, err := s.db.QueryContext(ctx, `
					SELECT t.entry_id
					FROM term_deletes d
					CROSS JOIN entry_terms t
					CROSS JOIN entries e
					WHERE d.signature = ? AND t.term = d.term
					  AND e.id = t.entry_id
					ORDER BY e.headword COLLATE NOCASE, e.id
					LIMIT ?`, signature, remaining)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var entryID string
			if err := rows.Scan(&entryID); err != nil {
				rows.Close()
				return nil, err
			}
			recordTypoCandidate(candidates, entryID, len(directTerms)+index)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}
	}
	return s.queryTypoCandidateSuggestions(ctx, candidates, limit)
}

func (s *Service) collectDirectTypoCandidates(ctx context.Context, terms []string, candidates map[string]int) error {
	if len(terms) == 0 {
		return nil
	}
	var statement strings.Builder
	statement.WriteString("WITH candidate_terms(term, typo_rank) AS (VALUES ")
	arguments := make([]any, 0, len(terms)*2+1)
	for index, term := range terms {
		if index > 0 {
			statement.WriteString(",")
		}
		statement.WriteString("(?, ?)")
		arguments = append(arguments, term, index)
	}
	statement.WriteString(`)
	SELECT t.entry_id, MIN(c.typo_rank)
	FROM candidate_terms c
	CROSS JOIN entry_terms t
	CROSS JOIN entries e
	WHERE t.term = c.term
	  AND e.id = t.entry_id
	GROUP BY t.entry_id, e.headword
	ORDER BY MIN(c.typo_rank), e.headword COLLATE NOCASE, e.id
	LIMIT ?`)
	arguments = append(arguments, maxTypoMatches)
	rows, err := s.db.QueryContext(ctx, statement.String(), arguments...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var entryID string
		var rank int
		if err := rows.Scan(&entryID, &rank); err != nil {
			return err
		}
		recordTypoCandidate(candidates, entryID, rank)
	}
	return rows.Err()
}

func (s *Service) queryTypoCandidateSuggestions(ctx context.Context, candidates map[string]int, limit int) ([]suggestion, error) {
	if len(candidates) == 0 {
		return make([]suggestion, 0), nil
	}
	ordered := make([]typoCandidate, 0, len(candidates))
	for entryID, rank := range candidates {
		ordered = append(ordered, typoCandidate{entryID: entryID, rank: rank})
	}
	sort.Slice(ordered, func(left, right int) bool {
		if ordered[left].rank != ordered[right].rank {
			return ordered[left].rank < ordered[right].rank
		}
		return ordered[left].entryID < ordered[right].entryID
	})

	var statement strings.Builder
	statement.WriteString("WITH candidates(entry_id, typo_rank) AS (VALUES ")
	arguments := make([]any, 0, len(ordered)*2+1)
	for index, candidate := range ordered {
		if index > 0 {
			statement.WriteString(",")
		}
		statement.WriteString("(?, ?)")
		arguments = append(arguments, candidate.entryID, candidate.rank)
	}
	statement.WriteString(`)
SELECT e.id, e.headword, e.parts_of_speech, e.translation_preview
FROM candidates c
CROSS JOIN entries e
WHERE e.id = c.entry_id
ORDER BY c.typo_rank, e.headword COLLATE NOCASE ASC, e.id ASC
LIMIT ?`)
	arguments = append(arguments, limit)
	rows, err := s.db.QueryContext(ctx, statement.String(), arguments...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	results := make([]suggestion, 0, limit)
	for rows.Next() {
		var item suggestion
		var partsOfSpeech string
		if err := rows.Scan(&item.ID, &item.Headword, &partsOfSpeech, &item.TranslationPreview); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(partsOfSpeech), &item.PartsOfSpeech); err != nil || item.PartsOfSpeech == nil {
			s.logger.Error("dictionary search projection is malformed", "id", item.ID, "error", err)
			return nil, errors.New("dictionary search projection is malformed")
		}
		results = append(results, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return results, nil
}

func recordTypoCandidate(candidates map[string]int, entryID string, rank int) {
	if currentRank, exists := candidates[entryID]; !exists || rank < currentRank {
		candidates[entryID] = rank
	}
}

func (s *Service) entry(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if id == "" || len(id) > 512 {
		s.writeError(w, r, http.StatusBadRequest, "invalid_id", "entry id is invalid")
		return
	}
	var headword string
	var compressed []byte
	var size int64
	var checksum []byte
	err := s.db.QueryRowContext(r.Context(), `SELECT headword, payload, payload_size, payload_sha256 FROM entries WHERE id = ?`, id).Scan(&headword, &compressed, &size, &checksum)
	if errors.Is(err, sql.ErrNoRows) {
		s.writeError(w, r, http.StatusNotFound, "entry_not_found", "entry was not found")
		return
	}
	if err != nil {
		s.logger.Error("dictionary entry lookup failed", "error", err)
		s.writeError(w, r, http.StatusInternalServerError, "entry_lookup_failed", "entry could not be loaded")
		return
	}
	if s.payloadCodec == nil {
		s.writeError(w, r, http.StatusInternalServerError, "unsupported_payload_codec", "entry uses an unsupported payload codec")
		return
	}
	if size < 0 || size > maxEntrySize {
		s.writeError(w, r, http.StatusInternalServerError, "invalid_entry_body", "entry has invalid source data")
		return
	}
	rawBody, err := s.payloadCodec.Decompress(compressed, size)
	digest := sha256.Sum256(rawBody)
	if err != nil || !bytes.Equal(digest[:], checksum) || !json.Valid(rawBody) {
		s.logger.Error("dictionary entry has malformed body", "id", id)
		s.writeError(w, r, http.StatusInternalServerError, "invalid_entry_body", "entry has invalid source data")
		return
	}
	s.writeJSON(w, http.StatusOK, struct {
		EntryID       string          `json:"entryId"`
		Headword      string          `json:"headword"`
		SourceVersion string          `json:"sourceVersion"`
		Body          json.RawMessage `json:"body"`
	}{EntryID: id, Headword: headword, SourceVersion: s.sourceVersion, Body: json.RawMessage(rawBody)})
}

func (s *Service) headwordAudio(w http.ResponseWriter, r *http.Request) {
	key := r.URL.Query().Get("key")
	if s.audio == nil {
		s.writeError(w, r, http.StatusServiceUnavailable, "audio_unavailable", "audio source is unavailable")
		return
	}
	reader, size, err := s.audio.Open(key)
	if errors.Is(err, audio.ErrNotFound) {
		s.writeError(w, r, http.StatusNotFound, "audio_not_found", "audio asset was not found")
		return
	}
	if err != nil {
		s.logger.Error("audio open failed", "error", err)
		s.writeError(w, r, http.StatusInternalServerError, "audio_open_failed", "audio asset could not be loaded")
		return
	}
	defer reader.Close()
	w.Header().Set("Content-Type", "audio/mpeg")
	w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.WriteHeader(http.StatusOK)
	if _, err := io.Copy(w, reader); err != nil {
		s.logger.Debug("audio stream interrupted", "error", err)
	}
}

func (s *Service) remoteMediaRedirect(kind media.Kind) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s.redirectRemoteMedia(w, r, kind)
	}
}

func (s *Service) illustration(w http.ResponseWriter, r *http.Request) {
	kind := media.Illustration
	switch r.URL.Query().Get("variant") {
	case "", "full":
	case "thumbnail":
		kind = media.IllustrationThumbnail
	default:
		s.writeError(w, r, http.StatusNotFound, "media_not_found", "media asset was not found")
		return
	}
	s.redirectRemoteMedia(w, r, kind)
}

func (s *Service) redirectRemoteMedia(w http.ResponseWriter, r *http.Request, kind media.Kind) {
	target, err := s.remoteMedia.Resolve(kind, r.URL.Query().Get("key"))
	if errors.Is(err, media.ErrUnavailable) && kind == media.IllustrationThumbnail {
		target, err = s.remoteMedia.Resolve(media.Illustration, r.URL.Query().Get("key"))
	}
	if errors.Is(err, media.ErrUnavailable) {
		s.writeError(w, r, http.StatusServiceUnavailable, "media_unavailable", "media source is unavailable")
		return
	}
	if errors.Is(err, media.ErrInvalidKey) {
		s.writeError(w, r, http.StatusNotFound, "media_not_found", "media asset was not found")
		return
	}
	if err != nil {
		s.logger.Error("media URL resolution failed", "kind", kind, "error", err)
		s.writeError(w, r, http.StatusInternalServerError, "media_resolution_failed", "media asset could not be resolved")
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=86400")
	http.Redirect(w, r, target, http.StatusTemporaryRedirect)
}

func (s *Service) withRequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestID := newRequestID()
		w.Header().Set("X-Request-ID", requestID)
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), requestIDContextKey{}, requestID)))
	})
}

func (s *Service) withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" {
			if _, allowed := s.allowedOrigins[origin]; !allowed {
				s.writeError(w, r, http.StatusForbidden, "origin_forbidden", "origin is not allowed")
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Service) withLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		next.ServeHTTP(w, r)
		s.logger.Info("request completed", "request_id", requestID(r), "method", r.Method, "path", r.URL.Path, "duration", time.Since(started))
	})
}

func (s *Service) writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(body); err != nil {
		s.logger.Debug("response write failed", "error", err)
	}
}

func (s *Service) writeError(w http.ResponseWriter, r *http.Request, status int, code, message string) {
	s.writeJSON(w, status, struct {
		RequestID string `json:"requestId"`
		Error     struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}{RequestID: requestID(r), Error: struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}{Code: code, Message: message}})
}

func requestID(r *http.Request) string {
	requestID, _ := r.Context().Value(requestIDContextKey{}).(string)
	return requestID
}

func newRequestID() string {
	var value [12]byte
	if _, err := rand.Read(value[:]); err == nil {
		return hex.EncodeToString(value[:])
	}
	return strconv.FormatInt(time.Now().UnixNano(), 36)
}

func parseLimit(value string) (int, error) {
	if value == "" {
		return defaultLimit, nil
	}
	limit, err := strconv.Atoi(value)
	if err != nil || limit < 1 || limit > maxLimit {
		return 0, fmt.Errorf("limit must be an integer between 1 and %d", maxLimit)
	}
	return limit, nil
}
