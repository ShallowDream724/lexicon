// Package semanticsearch reads the immutable semantic-search sidecar and queries it.
package semanticsearch

import (
	"errors"
	"fmt"
	"strings"
)

const (
	SchemaVersion     = "1"
	ProjectionVersion = "1.0"

	maxMatches           = 3
	maxDimensions        = 4096
	maxVectors           = 4_000_000
	maxResidentVectorB   = 512 << 20
	maximumCandidatePool = 4096
	maximumResultGroups  = 512
)

type Scope string

const (
	ScopeSense   Scope = "sense"
	ScopePhrase  Scope = "phrase"
	ScopeForm    Scope = "form"
	ScopeUsage   Scope = "usage"
	ScopeExample Scope = "example"
)

var orderedScopes = [...]Scope{ScopeSense, ScopePhrase, ScopeForm, ScopeUsage, ScopeExample}

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
	Scope    Scope
	English  string
	Chinese  string
	Location Location
	Score    float32
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
