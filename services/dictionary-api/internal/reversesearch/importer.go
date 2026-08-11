package reversesearch

import (
	"bufio"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf8"

	"dictionary-api/internal/searchtext"
	"golang.org/x/text/unicode/norm"
	_ "modernc.org/sqlite"
)

// Import streams an already ordered NDJSON projection into a new immutable sidecar.
func Import(ctx context.Context, config ImportConfig) error {
	if config.Documents == nil || strings.TrimSpace(config.DictionaryPath) == "" || strings.TrimSpace(config.TargetPath) == "" || strings.TrimSpace(config.SourceVersion) == "" || strings.TrimSpace(config.ProjectionVersion) == "" {
		return errors.New("documents, dictionary path, target path, source version, and projection version are required")
	}
	if config.ProjectionVersion != ProjectionVersion {
		return fmt.Errorf("unsupported reverse-search projection version %q", config.ProjectionVersion)
	}
	if err := validatePageSize(config.PageSize); err != nil {
		return err
	}
	if _, err := os.Stat(config.TargetPath); err == nil && !config.Replace {
		return fmt.Errorf("target database already exists: %s", config.TargetPath)
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	primarySHA, err := fileSHA256(config.DictionaryPath)
	if err != nil {
		return fmt.Errorf("fingerprint primary dictionary: %w", err)
	}

	temporary, err := os.CreateTemp(filepath.Dir(config.TargetPath), ".reverse-search-*.db")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Remove(temporaryPath); err != nil {
		return err
	}
	defer os.Remove(temporaryPath)

	db, err := sql.Open("sqlite", temporaryPath)
	if err != nil {
		return err
	}
	closed := false
	defer func() {
		if !closed {
			_ = db.Close()
		}
	}()
	if config.PageSize == 0 {
		config.PageSize = defaultPageSize
	}
	if _, err := db.ExecContext(ctx, "PRAGMA page_size = "+strconv.Itoa(config.PageSize)); err != nil {
		return fmt.Errorf("set SQLite page size: %w", err)
	}
	if _, err := db.ExecContext(ctx, "PRAGMA journal_mode = OFF"); err != nil {
		return fmt.Errorf("disable temporary SQLite journal: %w", err)
	}
	if _, err := db.ExecContext(ctx, "PRAGMA synchronous = OFF"); err != nil {
		return fmt.Errorf("configure temporary SQLite synchronization: %w", err)
	}
	if err := applySchema(ctx, db); err != nil {
		return err
	}
	documentCount, segmentCount, formCount, headwordTermCount, err := streamDocuments(ctx, db, config.Documents)
	if err != nil {
		return err
	}
	if documentCount == 0 {
		return errors.New("reverse-search projection contains no documents")
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO documents_fts(documents_fts) VALUES('optimize')`); err != nil {
		return fmt.Errorf("optimize reverse-search index: %w", err)
	}
	var englishTermCount int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM english_terms`).Scan(&englishTermCount); err != nil {
		return fmt.Errorf("count English search terms: %w", err)
	}
	if err := writeMetadata(ctx, db, config, primarySHA, documentCount, segmentCount, formCount, headwordTermCount, englishTermCount); err != nil {
		return err
	}
	if _, err := db.ExecContext(ctx, "VACUUM"); err != nil {
		return fmt.Errorf("compact reverse-search sidecar: %w", err)
	}
	if err := db.Close(); err != nil {
		return err
	}
	closed = true
	return replaceAtomically(temporaryPath, config.TargetPath, config.Replace)
}

func validatePageSize(pageSize int) error {
	if pageSize == 0 {
		return nil
	}
	if pageSize < 512 || pageSize > 65536 || pageSize&(pageSize-1) != 0 {
		return fmt.Errorf("SQLite page size %d must be a power of two from 512 through 65536", pageSize)
	}
	return nil
}

func applySchema(ctx context.Context, db *sql.DB) error {
	statements := []string{
		`CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID`,
		`CREATE TABLE documents (
			id INTEGER PRIMARY KEY,
			dictionary_id TEXT NOT NULL CHECK(length(dictionary_id) BETWEEN 1 AND 256),
			entry_id TEXT NOT NULL CHECK(length(entry_id) BETWEEN 1 AND 256),
				scope TEXT NOT NULL CHECK(scope IN ('sense','phrase','example','form','resource')),
				headword TEXT NOT NULL CHECK(length(headword) <= 32768),
				english_text TEXT NOT NULL CHECK(length(english_text) <= 32768),
				candidate_text TEXT NOT NULL CHECK(length(candidate_text) <= 32768),
				definition_text TEXT NOT NULL CHECK(length(definition_text) <= 32768),
				chinese_text TEXT NOT NULL CHECK(length(chinese_text) <= 32768),
					semantic_role TEXT NOT NULL CHECK(semantic_role IN ('definition','qualifier','guidance','expression','example','heading','context')),
					origin TEXT NOT NULL CHECK(origin IN ('','use','dis-g','grammar-usage-box')),
					resource_category TEXT NOT NULL CHECK(resource_category IN ('','grammar','express-yourself','vocabulary-building','synonyms','which-word','language-bank','collocations','homophones','british-american','more-about','wordfinder','help','origin','note','other')),
				section TEXT NOT NULL CHECK(section IN ('definitions','idioms','phrasal-verbs','derived-forms','grammar-usage')),
			part TEXT NOT NULL CHECK(length(part) <= 1024),
			owner_id TEXT NOT NULL CHECK(length(owner_id) <= 256),
			path_json TEXT NOT NULL CHECK(length(path_json) <= 8192),
			weight INTEGER NOT NULL CHECK(weight BETWEEN -1000000 AND 1000000)
		)`,
		`CREATE TABLE exact_segments (
				normalized TEXT NOT NULL CHECK(length(normalized) BETWEEN 1 AND 200),
				document_id INTEGER NOT NULL,
				PRIMARY KEY(normalized, document_id)
				) WITHOUT ROWID`,
		`CREATE TABLE entry_headword_forms (
					entry_id TEXT NOT NULL CHECK(length(entry_id) BETWEEN 1 AND 256),
					form TEXT NOT NULL CHECK(length(form) BETWEEN 1 AND 256),
					PRIMARY KEY(entry_id, form)
				) WITHOUT ROWID`,
		`CREATE TABLE entry_headword_terms (
					term TEXT NOT NULL CHECK(length(term) BETWEEN 1 AND 32768),
					entry_id TEXT NOT NULL CHECK(length(entry_id) BETWEEN 1 AND 256),
					PRIMARY KEY(term, entry_id)
					) WITHOUT ROWID`,
		`CREATE TABLE english_terms (
							term TEXT NOT NULL CHECK(length(term) BETWEEN 1 AND 1024),
							entry_id TEXT NOT NULL CHECK(length(entry_id) BETWEEN 1 AND 256),
								kind TEXT NOT NULL CHECK(kind IN ('headword','form','phrase','pattern')),
							headword TEXT NOT NULL CHECK(length(headword) <= 32768),
							display TEXT NOT NULL CHECK(length(display) <= 32768),
							document_id INTEGER NOT NULL CHECK(document_id >= 0),
							CHECK(
								(kind = 'headword' AND headword = '' AND display <> '' AND document_id = 0) OR
								(kind = 'form' AND headword <> '' AND display <> '' AND document_id = 0) OR
									(kind = 'phrase' AND headword = '' AND display = '' AND document_id > 0) OR
									(kind = 'pattern' AND headword = '' AND display <> '' AND document_id > 0)
							),
							PRIMARY KEY(term, entry_id, kind, document_id)
						) WITHOUT ROWID`,
		`CREATE INDEX documents_by_entry_scope ON documents(entry_id, scope)`,
		`CREATE VIRTUAL TABLE documents_fts USING fts5(tokens, content='', detail=none)`,
	}
	for _, statement := range statements {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("create reverse-search schema: %w", err)
		}
	}
	return nil
}

func streamDocuments(ctx context.Context, db *sql.DB, source io.Reader) (int, int, int, int, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, 0, 0, err
	}
	defer tx.Rollback()
	insertDocument, err := tx.PrepareContext(ctx, `INSERT INTO documents (dictionary_id, entry_id, scope, headword, english_text, candidate_text, definition_text, chinese_text, semantic_role, origin, resource_category, section, part, owner_id, path_json, weight) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return 0, 0, 0, 0, err
	}
	defer insertDocument.Close()
	insertFTS, err := tx.PrepareContext(ctx, `INSERT INTO documents_fts(rowid, tokens) VALUES (?, ?)`)
	if err != nil {
		return 0, 0, 0, 0, err
	}
	defer insertFTS.Close()
	insertExactSegment, err := tx.PrepareContext(ctx, `INSERT INTO exact_segments(normalized, document_id) VALUES (?, ?)`)
	if err != nil {
		return 0, 0, 0, 0, err
	}
	defer insertExactSegment.Close()
	insertHeadwordForm, err := tx.PrepareContext(ctx, `INSERT OR IGNORE INTO entry_headword_forms(entry_id, form) VALUES (?, ?)`)
	if err != nil {
		return 0, 0, 0, 0, err
	}
	defer insertHeadwordForm.Close()
	insertHeadwordTerm, err := tx.PrepareContext(ctx, `INSERT OR IGNORE INTO entry_headword_terms(term, entry_id) VALUES (?, ?)`)
	if err != nil {
		return 0, 0, 0, 0, err
	}
	defer insertHeadwordTerm.Close()
	insertEnglishTerm, err := tx.PrepareContext(ctx, `INSERT OR IGNORE INTO english_terms(term, entry_id, kind, headword, display, document_id) VALUES (?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return 0, 0, 0, 0, err
	}
	defer insertEnglishTerm.Close()

	reader := bufio.NewReaderSize(source, maxLineBytes+1)
	count := 0
	segmentCount := 0
	formCount := 0
	headwordTermCount := 0
	lastEntry := ""
	lastHeadwordForms := make(map[string]struct{})
	lastHeadwordTerms := make(map[string]struct{})
	for lineNumber := 1; ; lineNumber++ {
		line, readErr := reader.ReadBytes('\n')
		if len(line) > maxLineBytes {
			return 0, 0, 0, 0, fmt.Errorf("projection line %d exceeds %d bytes", lineNumber, maxLineBytes)
		}
		if len(line) > 0 {
			line = bytesTrimSpace(line)
			if len(line) > 0 {
				document, err := decodeDocument(line)
				if err != nil {
					return 0, 0, 0, 0, fmt.Errorf("projection line %d: %w", lineNumber, err)
				}
				if document.EntryID < lastEntry {
					return 0, 0, 0, 0, fmt.Errorf("projection line %d is out of order by entryId", lineNumber)
				}
				newEntry := document.EntryID != lastEntry
				if newEntry {
					clear(lastHeadwordForms)
					clear(lastHeadwordTerms)
				}
				lastEntry = document.EntryID
				pathJSON, _ := json.Marshal(document.Location.Path)
				result, err := insertDocument.ExecContext(ctx, document.DictionaryID, document.EntryID, document.Scope, document.Headword, document.EnglishText, document.CandidateText, document.DefinitionText, document.ChineseText, document.SemanticRole, document.Origin, document.ResourceCategory, document.Location.Section, document.Location.Part, document.Location.OwnerID, string(pathJSON), document.Weight)
				if err != nil {
					return 0, 0, 0, 0, err
				}
				id, err := result.LastInsertId()
				if err != nil {
					return 0, 0, 0, 0, err
				}
				if newEntry {
					if err := insertEnglishSurface(ctx, insertEnglishTerm, document.EntryID, document.Headword, "headword", document.Headword); err != nil {
						return 0, 0, 0, 0, err
					}
					for _, form := range document.HeadwordForms {
						if err := insertEnglishSurface(ctx, insertEnglishTerm, document.EntryID, document.Headword, "form", form); err != nil {
							return 0, 0, 0, 0, err
						}
					}
				}
				if document.Scope == ScopePhrase && strings.TrimSpace(document.CandidateText) != "" {
					for _, term := range searchtext.PhraseIndexTerms(document.CandidateText) {
						if _, err := insertEnglishTerm.ExecContext(ctx, term, document.EntryID, "phrase", "", "", id); err != nil {
							return 0, 0, 0, 0, err
						}
					}
				}
				for _, lookup := range document.EnglishLookupTerms {
					for _, term := range searchtext.PhraseIndexTerms(lookup.Text) {
						if _, err := insertEnglishTerm.ExecContext(ctx, term, document.EntryID, lookup.Kind, "", lookup.Text, id); err != nil {
							return 0, 0, 0, 0, err
						}
					}
				}
				for _, value := range append([]string{document.Headword}, document.HeadwordForms...) {
					term := searchtext.NormalizeHeadwordTerm(value)
					if term == "" {
						continue
					}
					if _, exists := lastHeadwordTerms[term]; exists {
						continue
					}
					lastHeadwordTerms[term] = struct{}{}
					result, err := insertHeadwordTerm.ExecContext(ctx, term, document.EntryID)
					if err != nil {
						return 0, 0, 0, 0, err
					}
					inserted, err := result.RowsAffected()
					if err != nil {
						return 0, 0, 0, 0, err
					}
					headwordTermCount += int(inserted)
				}
				for _, form := range document.HeadwordForms {
					if _, exists := lastHeadwordForms[form]; exists {
						continue
					}
					lastHeadwordForms[form] = struct{}{}
					result, err := insertHeadwordForm.ExecContext(ctx, document.EntryID, form)
					if err != nil {
						return 0, 0, 0, 0, err
					}
					inserted, err := result.RowsAffected()
					if err != nil {
						return 0, 0, 0, 0, err
					}
					formCount += int(inserted)
				}
				if _, err := insertFTS.ExecContext(ctx, id, strings.Join(tokens(document.ChineseText), " ")); err != nil {
					return 0, 0, 0, 0, err
				}
				seenSegments := make(map[string]struct{})
				for _, sequence := range cjkSequences(document.ChineseText) {
					if len(sequence) > MaxQueryRunes {
						continue
					}
					normalized := string(sequence)
					if _, exists := seenSegments[normalized]; exists {
						continue
					}
					seenSegments[normalized] = struct{}{}
					if _, err := insertExactSegment.ExecContext(ctx, normalized, id); err != nil {
						return 0, 0, 0, 0, err
					}
					segmentCount++
				}
				count++
			}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return 0, 0, 0, 0, readErr
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, 0, 0, 0, err
	}
	return count, segmentCount, formCount, headwordTermCount, nil
}

func decodeDocument(line []byte) (SearchDocument, error) {
	if !utf8.Valid(line) {
		return SearchDocument{}, errors.New("invalid UTF-8")
	}
	decoder := json.NewDecoder(strings.NewReader(string(line)))
	decoder.DisallowUnknownFields()
	var document SearchDocument
	if err := decoder.Decode(&document); err != nil {
		return SearchDocument{}, fmt.Errorf("invalid JSON: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return SearchDocument{}, errors.New("multiple JSON values")
	}
	if len(document.HeadwordForms) > maxHeadwordForms {
		return SearchDocument{}, fmt.Errorf("headwordForms exceeds %d items", maxHeadwordForms)
	}
	if len(document.EnglishLookupTerms) > maxEnglishLookups {
		return SearchDocument{}, fmt.Errorf("englishLookupTerms exceeds %d items", maxEnglishLookups)
	}
	for index, form := range document.HeadwordForms {
		if !validLimited(form, maxIDBytes) {
			return SearchDocument{}, errors.New("headwordForms contains an invalid or oversized form")
		}
		normalized := normalizeHeadwordForm(form)
		if !validLimited(normalized, maxIDBytes) {
			return SearchDocument{}, errors.New("headwordForms normalization produced an invalid or oversized form")
		}
		document.HeadwordForms[index] = normalized
	}
	if err := validateDocument(document); err != nil {
		return SearchDocument{}, err
	}
	return document, nil
}

func validateDocument(document SearchDocument) error {
	if !validLimited(document.DictionaryID, maxIDBytes) || !validLimited(document.EntryID, maxIDBytes) {
		return errors.New("dictionaryId and entryId are required and bounded")
	}
	if !validLimited(document.Headword, maxTextBytes) || !validOptional(document.EnglishText, maxTextBytes) || !validOptional(document.CandidateText, maxTextBytes) || !validOptional(document.DefinitionText, maxTextBytes) || !validLimited(document.ChineseText, maxTextBytes) {
		return errors.New("headword and chineseText are required; all text fields must be bounded")
	}
	if len(document.HeadwordForms) > maxHeadwordForms {
		return fmt.Errorf("headwordForms exceeds %d items", maxHeadwordForms)
	}
	for _, form := range document.HeadwordForms {
		if !validLimited(form, maxIDBytes) {
			return errors.New("headwordForms contains an invalid or oversized form")
		}
	}
	if len(document.EnglishLookupTerms) > maxEnglishLookups {
		return fmt.Errorf("englishLookupTerms exceeds %d items", maxEnglishLookups)
	}
	for _, lookup := range document.EnglishLookupTerms {
		if lookup.Kind != EnglishTermPattern || !validLimited(lookup.Text, maxEnglishTermB) {
			return errors.New("englishLookupTerms contains an invalid kind or text")
		}
	}
	if len(cjkRunes(document.ChineseText)) == 0 {
		return errors.New("chineseText contains no CJK characters")
	}
	if !validScope(document.Scope) || !validSection(document.Location.Section) || !validSemanticRole(document.SemanticRole) || !validOrigin(document.Origin) {
		return errors.New("unknown scope or section")
	}
	if document.Scope == ScopeResource {
		if !validResourceCategory(document.ResourceCategory) {
			return errors.New("resource document category is invalid")
		}
	} else if document.ResourceCategory != "" {
		return errors.New("resource category is only valid for resource documents")
	}
	if !validOptional(document.Location.Part, 1024) || !validOptional(document.Location.OwnerID, maxIDBytes) || len(document.Location.Path) > maxPathParts {
		return errors.New("location is invalid or exceeds bounds")
	}
	for _, segment := range document.Location.Path {
		if !validLimited(segment, maxIDBytes) {
			return errors.New("location path contains an invalid segment")
		}
	}
	if document.Weight < -1000000 || document.Weight > 1000000 {
		return errors.New("weight exceeds bounds")
	}
	return nil
}

func validLimited(value string, maximum int) bool {
	return utf8.ValidString(value) && strings.TrimSpace(value) != "" && len(value) <= maximum
}
func validOptional(value string, maximum int) bool {
	return utf8.ValidString(value) && len(value) <= maximum
}
func validScope(value Scope) bool {
	return value == ScopeSense || value == ScopePhrase || value == ScopeExample || value == ScopeForm || value == ScopeResource
}
func validSection(value Section) bool {
	return value == SectionDefinitions || value == SectionIdioms || value == SectionPhrasalVerbs || value == SectionDerivedForms || value == SectionGrammarUsage
}

func writeMetadata(ctx context.Context, db *sql.DB, config ImportConfig, primarySHA string, documentCount, segmentCount, formCount, headwordTermCount, englishTermCount int) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	values := map[string]string{
		"schema_version": strconv.Itoa(SchemaVersion), "projection_version": config.ProjectionVersion,
		"normalizer_version": NormalizerVersion, "primary_sha256": primarySHA,
		"source_version": config.SourceVersion, "document_count": strconv.Itoa(documentCount),
		"segment_count": strconv.Itoa(segmentCount), "form_count": strconv.Itoa(formCount), "headword_term_count": strconv.Itoa(headwordTermCount), "english_term_count": strconv.Itoa(englishTermCount),
	}
	for _, key := range []string{"schema_version", "projection_version", "normalizer_version", "primary_sha256", "source_version", "document_count", "segment_count", "form_count", "headword_term_count", "english_term_count"} {
		if _, err := tx.ExecContext(ctx, `INSERT INTO metadata(key, value) VALUES (?, ?)`, key, values[key]); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func insertEnglishSurface(ctx context.Context, statement *sql.Stmt, entryID, headword, kind, display string) error {
	term := searchtext.NormalizeHeadwordTerm(display)
	if term == "" || len(term) > 1024 {
		return nil
	}
	storedHeadword := ""
	if kind == "form" {
		storedHeadword = headword
	}
	_, err := statement.ExecContext(ctx, term, entryID, kind, storedHeadword, display, 0)
	return err
}

func normalizeHeadwordForm(value string) string {
	return strings.Join(strings.Fields(norm.NFKC.String(value)), " ")
}

func FileSHA256(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

func fileSHA256(path string) (string, error) { return FileSHA256(path) }

func bytesTrimSpace(value []byte) []byte {
	return []byte(strings.TrimSpace(string(value)))
}
