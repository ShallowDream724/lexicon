// Package reversesearch builds and reads the immutable Chinese reverse-search sidecar.
package reversesearch

import "io"

const (
	SchemaVersion     = 2
	ProjectionVersion = "1.1"
	NormalizerVersion = "nfkc-cjk-v1"
	defaultPageSize   = 8192
	defaultCandidates = 4096
	maxResults        = 512
	maxMatches        = 3
	maxQueryRunes     = 200
	maxLineBytes      = 1 << 20
	maxIDBytes        = 256
	maxTextBytes      = 32 << 10
	maxPathParts      = 32
)

type Scope string

const (
	ScopeSense   Scope = "sense"
	ScopePhrase  Scope = "phrase"
	ScopeExample Scope = "example"
	ScopeUsage   Scope = "usage"
	ScopeForm    Scope = "form"
)

type Section string

const (
	SectionDefinitions  Section = "definitions"
	SectionIdioms       Section = "idioms"
	SectionPhrasalVerbs Section = "phrasal-verbs"
	SectionDerivedForms Section = "derived-forms"
	SectionGrammarUsage Section = "grammar-usage"
)

// SearchDocument is one line of the stable projection NDJSON contract.
type SearchDocument struct {
	DictionaryID string   `json:"dictionaryId"`
	EntryID      string   `json:"entryId"`
	Scope        Scope    `json:"scope"`
	Headword     string   `json:"headword"`
	EnglishText  string   `json:"englishText"`
	ChineseText  string   `json:"chineseText"`
	Location     Location `json:"location"`
	Weight       int      `json:"weight"`
}

type Location struct {
	Section Section  `json:"section"`
	Part    string   `json:"part,omitempty"`
	OwnerID string   `json:"ownerId,omitempty"`
	Path    []string `json:"path,omitempty"`
}

type ImportConfig struct {
	Documents         io.Reader
	DictionaryPath    string
	TargetPath        string
	SourceVersion     string
	ProjectionVersion string
	Replace           bool
	PageSize          int
}

type Match struct {
	Scope    Scope
	English  string
	Chinese  string
	Location Location
}

type Group struct {
	EntryID  string
	Headword string
	Matches  []Match
}

type Page struct {
	Groups     []Group
	NextOffset int
	HasMore    bool
}
