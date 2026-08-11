// Package reversesearch builds and reads the immutable Chinese reverse-search sidecar.
package reversesearch

import "io"

const (
	SchemaVersion     = 9
	ProjectionVersion = "2.2"
	NormalizerVersion = "nfkc-opencc-t2s-v1"
	defaultPageSize   = 8192
	defaultCandidates = 4096
	maxResults        = 512
	maxMatches        = 8
	MaxQueryRunes     = 200
	maxLineBytes      = 1 << 20
	maxIDBytes        = 256
	maxEnglishTermB   = 1024
	maxHeadwordForms  = 64
	maxEnglishLookups = 64
	maxTextBytes      = 32 << 10
	maxPathParts      = 32
)

type Scope string

const (
	ScopeSense    Scope = "sense"
	ScopePhrase   Scope = "phrase"
	ScopeExample  Scope = "example"
	ScopeForm     Scope = "form"
	ScopeResource Scope = "resource"
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

type SemanticRole string

const (
	SemanticRoleDefinition SemanticRole = "definition"
	SemanticRoleQualifier  SemanticRole = "qualifier"
	SemanticRoleGuidance   SemanticRole = "guidance"
	SemanticRoleExpression SemanticRole = "expression"
	SemanticRoleExample    SemanticRole = "example"
	SemanticRoleHeading    SemanticRole = "heading"
	SemanticRoleContext    SemanticRole = "context"
)

type Origin string

const (
	OriginUse             Origin = "use"
	OriginDisplayGroup    Origin = "dis-g"
	OriginGrammarUsageBox Origin = "grammar-usage-box"
)

type ResourceCategory string

const (
	ResourceGrammar            ResourceCategory = "grammar"
	ResourceExpressYourself    ResourceCategory = "express-yourself"
	ResourceVocabularyBuilding ResourceCategory = "vocabulary-building"
	ResourceSynonyms           ResourceCategory = "synonyms"
	ResourceWhichWord          ResourceCategory = "which-word"
	ResourceLanguageBank       ResourceCategory = "language-bank"
	ResourceCollocations       ResourceCategory = "collocations"
	ResourceHomophones         ResourceCategory = "homophones"
	ResourceBritishAmerican    ResourceCategory = "british-american"
	ResourceMoreAbout          ResourceCategory = "more-about"
	ResourceWordfinder         ResourceCategory = "wordfinder"
	ResourceHelp               ResourceCategory = "help"
	ResourceOrigin             ResourceCategory = "origin"
	ResourceNote               ResourceCategory = "note"
	ResourceOther              ResourceCategory = "other"
)

// SearchDocument is one line of the stable projection NDJSON contract.
type SearchDocument struct {
	DictionaryID       string              `json:"dictionaryId"`
	EntryID            string              `json:"entryId"`
	Scope              Scope               `json:"scope"`
	Headword           string              `json:"headword"`
	HeadwordForms      []string            `json:"headwordForms,omitempty"`
	EnglishLookupTerms []EnglishLookupTerm `json:"englishLookupTerms,omitempty"`
	EnglishText        string              `json:"englishText"`
	CandidateText      string              `json:"candidateText,omitempty"`
	DefinitionText     string              `json:"definitionText,omitempty"`
	ChineseText        string              `json:"chineseText"`
	SemanticRole       SemanticRole        `json:"semanticRole"`
	Origin             Origin              `json:"origin,omitempty"`
	ResourceCategory   ResourceCategory    `json:"resourceCategory,omitempty"`
	Location           Location            `json:"location"`
	Weight             int                 `json:"weight"`
}

type EnglishLookupTerm struct {
	Kind EnglishTermKind `json:"kind"`
	Text string          `json:"text"`
}

type Location struct {
	Section Section  `json:"section"`
	Part    string   `json:"part,omitempty"`
	OwnerID string   `json:"ownerId,omitempty"`
	Path    []string `json:"path"`
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
	Scope            Scope
	English          string
	CandidateText    string
	DefinitionText   string
	Chinese          string
	SemanticRole     SemanticRole
	ResourceCategory ResourceCategory
	Location         Location
	Relevance        Relevance
}

// Relevance carries lexical evidence into the source-neutral HTTP fusion layer.
// Tier is a semantic invariant: 4 is an exact segment, 3 a grammatical
// extension, 2 a strong boundary, substring, or distributed match, and 1 a
// partial fallback.
type Relevance struct {
	Tier           int
	Score          float64
	Corroboration  int
	DocumentWeight int
}

type Group struct {
	EntryID            string
	Headword           string
	Relevance          Relevance
	Matches            []Match
	HeadwordAnchor     bool `json:"-"`
	HeadwordAnchorRank int  `json:"-"`
}

type Page struct {
	Groups     []Group
	NextOffset int
	HasMore    bool
}

type EnglishTermKind string

const (
	EnglishTermHeadword EnglishTermKind = "headword"
	EnglishTermForm     EnglishTermKind = "form"
	EnglishTermPhrase   EnglishTermKind = "phrase"
	EnglishTermPattern  EnglishTermKind = "pattern"
)

// EnglishTermMatch is exact canonical lexical evidence from the derived search index.
type EnglishTermMatch struct {
	Term     string
	EntryID  string
	Kind     EnglishTermKind
	Headword string
	Display  string
	Evidence *EnglishTermEvidence
}

// EnglishTermEvidence is attached only to phrase matches. It remains in the
// canonical documents table so the English-term index does not duplicate it.
type EnglishTermEvidence struct {
	Scope          Scope
	CandidateText  string
	DefinitionText string
	ChineseText    string
	SemanticRole   SemanticRole
	Location       Location
}

func validSemanticRole(value SemanticRole) bool {
	switch value {
	case SemanticRoleDefinition, SemanticRoleQualifier, SemanticRoleGuidance,
		SemanticRoleExpression, SemanticRoleExample, SemanticRoleHeading, SemanticRoleContext:
		return true
	default:
		return false
	}
}

func validOrigin(value Origin) bool {
	return value == "" || value == OriginUse || value == OriginDisplayGroup || value == OriginGrammarUsageBox
}

func validResourceCategory(value ResourceCategory) bool {
	switch value {
	case ResourceGrammar, ResourceExpressYourself, ResourceVocabularyBuilding, ResourceSynonyms,
		ResourceWhichWord, ResourceLanguageBank, ResourceCollocations, ResourceHomophones,
		ResourceBritishAmerican, ResourceMoreAbout, ResourceWordfinder, ResourceHelp,
		ResourceOrigin, ResourceNote, ResourceOther:
		return true
	default:
		return false
	}
}

func (value SemanticRole) RetrievalPriority() int {
	switch value {
	case SemanticRoleDefinition, SemanticRoleGuidance, SemanticRoleExpression, SemanticRoleExample:
		return 2
	case SemanticRoleQualifier, SemanticRoleContext:
		return 1
	case SemanticRoleHeading:
		return 0
	default:
		return -1
	}
}

func (value SemanticRole) EvidencePriority() int {
	switch value {
	case SemanticRoleDefinition, SemanticRoleExpression:
		return 3
	case SemanticRoleGuidance, SemanticRoleExample:
		return 2
	case SemanticRoleQualifier, SemanticRoleContext:
		return 1
	case SemanticRoleHeading:
		return 0
	default:
		return -1
	}
}
