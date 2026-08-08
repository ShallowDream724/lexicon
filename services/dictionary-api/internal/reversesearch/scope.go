package reversesearch

import (
	"errors"
	"fmt"
	"strings"
)

var orderedScopes = [...]Scope{ScopeSense, ScopePhrase, ScopeForm, ScopeUsage, ScopeExample}

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
			return ScopeFilter{}, fmt.Errorf("unknown reverse-search scope %q", scope)
		}
		filter.mask |= 1 << index
	}
	if filter.mask == 0 {
		return ScopeFilter{}, errors.New("reverse-search scope must not be empty")
	}
	return filter, nil
}

func ParseScopeFilter(value string) (ScopeFilter, error) {
	if value == "" {
		return ScopeFilter{}, errors.New("scope must not be empty")
	}
	parts := strings.Split(value, ",")
	scopes := make([]Scope, 0, len(parts))
	for _, part := range parts {
		if part == "" || strings.TrimSpace(part) != part {
			return ScopeFilter{}, errors.New("scope must be a comma-separated list without empty values or whitespace")
		}
		scopes = append(scopes, Scope(part))
	}
	filter, err := NewScopeFilter(scopes...)
	if err != nil {
		return ScopeFilter{}, errors.New("scope contains an unknown value")
	}
	return filter, nil
}

func (filter ScopeFilter) String() string {
	values, err := filter.values()
	if err != nil {
		return ""
	}
	parts := make([]string, len(values))
	for index, value := range values {
		parts[index] = string(value)
	}
	return strings.Join(parts, ",")
}

func (filter ScopeFilter) values() ([]Scope, error) {
	if filter.mask == 0 || filter.mask>>len(orderedScopes) != 0 {
		return nil, errors.New("reverse-search scope filter is invalid")
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
		if candidate == scope {
			return index
		}
	}
	return -1
}
