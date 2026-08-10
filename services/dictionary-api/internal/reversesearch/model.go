// Package reversesearch builds and reads the immutable Chinese reverse-search sidecar.
package reversesearch

import "io"

const (
	SchemaVersion     = 5
	ProjectionVersion = "1.4"
	NormalizerVersion = "nfkc-opencc-t2s-v1"
	defaultPageSize   = 8192
	defaultCandidates = 4096
	maxResults        = 512
	maxMatches        = 8
	MaxQueryRunes     = 200
	maxLineBytes      = 1 << 20
	maxIDBytes        = 256
	maxHeadwordForms  = 64
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

type ScopeFilter struct {
	mask uint8
}

type Options struct {
	Offset int
	Limit  int
	Scopes ScopeFilter
}

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
	DictionaryID   string   `json:"dictionaryId"`
	EntryID        string   `json:"entryId"`
	Scope          Scope    `json:"scope"`
	Headword       string   `json:"headword"`
	HeadwordForms  []string `json:"headwordForms,omitempty"`
	EnglishText    string   `json:"englishText"`
	CandidateText  string   `json:"candidateText,omitempty"`
	DefinitionText string   `json:"definitionText,omitempty"`
	ChineseText    string   `json:"chineseText"`
	Location       Location `json:"location"`
	Weight         int      `json:"weight"`
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
	Scope          Scope
	English        string
	CandidateText  string
	DefinitionText string
	Chinese        string
	Location       Location
	Relevance      Relevance
}

// Relevance carries lexical evidence into the source-neutral HTTP fusion layer.
// Tier is a semantic invariant: 4 is an exact segment, 3 a grammatical
// extension, 2 a full boundary/substring match, and 1 a partial fallback.
type Relevance struct {
	Tier           int
	Score          float64
	Corroboration  int
	DocumentWeight int
}

type Group struct {
	EntryID   string
	Headword  string
	Relevance Relevance
	Matches   []Match
}

type Page struct {
	Groups     []Group
	NextOffset int
	HasMore    bool
}
