// Package semanticsearch reads the immutable semantic-search sidecar and queries it.
package semanticsearch

import (
	"errors"
	"fmt"
	"math"
	"strings"
)

const (
	SchemaVersion     = "5"
	ProjectionVersion = "2.2"
	EvidenceScoreBand = float32(0.005)

	maxMatches           = 8
	maxDimensions        = 4096
	maxVectors           = 4_000_000
	maxResidentVectorB   = 512 << 20
	maximumCandidatePool = 4096
	maximumResultGroups  = 512
	maxQueryExtraJSONB   = 16 << 10
)

type Scope string

const (
	ScopeSense    Scope = "sense"
	ScopePhrase   Scope = "phrase"
	ScopeForm     Scope = "form"
	ScopeExample  Scope = "example"
	ScopeResource Scope = "resource"
)

var orderedScopes = [...]Scope{ScopeSense, ScopePhrase, ScopeForm, ScopeExample, ScopeResource}

// SemanticRole describes how a SearchDocument contributes to a semantic answer.
// Its ordering is intentionally shared with the hybrid ranking policy.
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

type ResourceCategory string

func (value ResourceCategory) Valid() bool {
	switch value {
	case "", "grammar", "express-yourself", "vocabulary-building", "synonyms", "which-word", "language-bank", "collocations", "homophones", "british-american", "more-about", "wordfinder", "help", "origin", "note", "other":
		return true
	default:
		return false
	}
}

func EvidenceBand(score float32) int {
	return int(math.Round(float64(score) / float64(EvidenceScoreBand)))
}

// ScopeFilter is a validated bit set that maps to the sidecar's scope_mask.
type ScopeFilter struct{ mask uint32 }

func DefaultScopeFilter() ScopeFilter {
	filter, _ := NewScopeFilter(ScopeSense, ScopePhrase, ScopeForm)
	return filter
}

func AllScopeFilter() ScopeFilter {
	filter, _ := NewScopeFilter(orderedScopes[:]...)
	return filter
}

func NewScopeFilter(scopes ...Scope) (ScopeFilter, error) {
	var filter ScopeFilter
	for _, scope := range scopes {
		index := scopeIndex(scope)
		if index < 0 {
			return ScopeFilter{}, fmt.Errorf("unknown semantic-search scope %q", scope)
		}
		filter.mask |= 1 << index
	}
	if filter.mask == 0 {
		return ScopeFilter{}, errors.New("semantic-search scope must not be empty")
	}
	return filter, nil
}

func (filter ScopeFilter) String() string {
	if filter.mask == 0 || filter.mask>>len(orderedScopes) != 0 {
		return ""
	}
	parts := make([]string, 0, len(orderedScopes))
	for index, scope := range orderedScopes {
		if filter.mask&(1<<index) != 0 {
			parts = append(parts, string(scope))
		}
	}
	return strings.Join(parts, ",")
}

func (filter ScopeFilter) values() ([]Scope, error) {
	if filter.mask == 0 || filter.mask>>len(orderedScopes) != 0 {
		return nil, errors.New("semantic-search scope filter is invalid")
	}
	values := make([]Scope, 0, len(orderedScopes))
	for index, scope := range orderedScopes {
		if filter.mask&(1<<index) != 0 {
			values = append(values, scope)
		}
	}
	return values, nil
}

func scopeIndex(scope Scope) int {
	for index, candidate := range orderedScopes {
		if scope == candidate {
			return index
		}
	}
	return -1
}

type Options struct {
	Offset int
	Limit  int
	Scopes ScopeFilter
}

type Location struct {
	Section string
	Part    string
	OwnerID string
	Path    []string
}

type Match struct {
	Scope            Scope
	SemanticRole     SemanticRole
	ResourceCategory ResourceCategory
	English          string
	Chinese          string
	CandidateText    string
	DefinitionText   string
	Location         Location
	Score            float32
}

type Group struct {
	EntryID  string
	Headword string
	Score    float32
	Matches  []Match
}

type Page struct {
	Groups     []Group
	NextOffset int
	HasMore    bool
}
