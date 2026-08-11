package server

import (
	"context"
	"errors"

	"dictionary-api/internal/englishsearch"
	"dictionary-api/internal/reversesearch"
	"dictionary-api/internal/searchtext"
	"dictionary-api/internal/termkey"
)

type englishSearchGroup struct {
	Text  string       `json:"text"`
	Kind  string       `json:"kind"`
	Items []suggestion `json:"items"`
}

type englishSpellingSuggestion struct {
	Input      string       `json:"input"`
	Suggestion string       `json:"suggestion"`
	Items      []suggestion `json:"items"`
}

// englishPlannerResolver owns the API-specific batch lookup adaptation. The
// planner remains storage-neutral, while this type guarantees a submitted
// request results in one reverse-sidecar English term query.
type englishPlannerResolver struct{ service *Service }

func (resolver englishPlannerResolver) ResolveEnglishSearch(ctx context.Context, request englishsearch.Request) (englishsearch.Results, error) {
	result := englishsearch.Results{
		Phrases:     make(map[string][]englishsearch.Match),
		Tokens:      make(map[string][]englishsearch.Match),
		Corrections: make(map[string][]englishsearch.Match),
	}
	terms := make([]string, 0, 1+len(request.PhraseProbes)+len(request.TokenProbes)+len(request.CorrectionProbes))
	terms = append(terms, request.Exact)
	for _, probe := range request.PhraseProbes {
		terms = append(terms, probe.Text)
	}
	for _, probe := range request.TokenProbes {
		terms = append(terms, probe.Text)
	}
	terms = append(terms, request.CorrectionProbes...)

	var matchesByTerm map[string][]reversesearch.EnglishTermMatch
	var err error
	if resolver.service.reverseSearch != nil {
		matchesByTerm, err = resolver.service.reverseSearch.LookupEnglishTerms(ctx, terms)
		if err != nil {
			return result, err
		}
	} else {
		matchesByTerm = make(map[string][]reversesearch.EnglishTermMatch)
	}

	lookup := func(term string) []englishsearch.Match {
		stored := matchesByTerm[searchtext.NormalizeHeadwordTerm(term)]
		matches := make([]englishsearch.Match, 0, len(stored))
		for _, item := range stored {
			matches = append(matches, englishMatchFromStored(item))
		}
		return matches
	}
	result.Exact = lookup(request.Exact)
	for _, probe := range request.PhraseProbes {
		result.Phrases[probe.Text] = lookup(probe.Text)
	}
	for _, probe := range request.TokenProbes {
		result.Tokens[probe.Text] = lookup(probe.Text)
	}
	for _, probe := range request.CorrectionProbes {
		result.Corrections[probe] = lookup(probe)
	}

	// A real etymology hit is exact evidence, so a known term such as "sough"
	// prevents the planner from offering a typo correction. It never contributes
	// to Chinese or semantic search.
	if resolver.service.etymology != nil {
		anchors, err := resolver.service.etymology.Prefix(ctx, request.Exact, 1)
		if err != nil {
			return result, err
		}
		if len(anchors) == 1 && termkey.Enhancement(anchors[0].Term) == termkey.Enhancement(request.Exact) {
			duplicates, err := resolver.service.dictionaryTermsExist(ctx, anchors)
			if err != nil {
				return result, err
			}
			if !duplicates[anchors[0].Term] {
				result.Exact = append(result.Exact, englishsearch.Match{
					EntryID: anchors[0].Term, Headword: anchors[0].Headword, Kind: englishsearch.MatchEtymology,
				})
			}
		}
	}
	return result, nil
}

func englishMatchFromStored(item reversesearch.EnglishTermMatch) englishsearch.Match {
	kind := englishsearch.MatchHeadword
	relation := ""
	switch item.Kind {
	case reversesearch.EnglishTermForm:
		kind, relation = englishsearch.MatchInflection, item.Headword
	case reversesearch.EnglishTermPhrase:
		kind = englishsearch.MatchPhrase
	case reversesearch.EnglishTermPattern:
		kind = englishsearch.MatchPattern
	}
	match := englishsearch.Match{
		EntryID: item.EntryID, Headword: item.Headword, Display: item.Display, Kind: kind, Relation: relation,
	}
	if item.Evidence != nil {
		match.Evidence = &englishsearch.Evidence{
			Scope:         string(item.Evidence.Scope),
			CandidateText: item.Evidence.CandidateText, DefinitionText: item.Evidence.DefinitionText,
			ChineseText: item.Evidence.ChineseText, SemanticRole: string(item.Evidence.SemanticRole),
			Location: englishsearch.Location{
				Section: string(item.Evidence.Location.Section), Part: item.Evidence.Location.Part,
				OwnerID: item.Evidence.Location.OwnerID, Path: append([]string(nil), item.Evidence.Location.Path...),
			},
		}
		match.Location = match.Evidence.Location
	}
	return match
}

func (s *Service) queryEnglishPlan(ctx context.Context, raw string, submitted bool) ([]englishSearchGroup, *englishSpellingSuggestion, error) {
	planner := englishsearch.New(englishsearch.Options{})
	plan, err := planner.Plan(ctx, raw, submitted, englishPlannerResolver{service: s})
	if err != nil {
		return nil, nil, err
	}
	groups := make([]englishSearchGroup, 0, 1+len(plan.Phrases)+len(plan.Tokens))
	appendGroup := func(group englishsearch.Group) error {
		items, err := s.englishSuggestionsForMatches(ctx, group.Matches)
		if err != nil {
			return err
		}
		groups = append(groups, englishSearchGroup{Text: group.Text, Kind: string(group.Kind), Items: items})
		return nil
	}
	if err := appendGroup(plan.Exact); err != nil {
		return nil, nil, err
	}
	for _, group := range plan.Phrases {
		if err := appendGroup(group); err != nil {
			return nil, nil, err
		}
	}
	for _, group := range plan.Tokens {
		if err := appendGroup(group); err != nil {
			return nil, nil, err
		}
	}
	if plan.Correction == nil {
		return groups, nil, nil
	}
	items, err := s.englishSuggestionsForMatches(ctx, plan.Correction.Matches)
	if err != nil {
		return nil, nil, err
	}
	return groups, &englishSpellingSuggestion{Input: plan.Correction.Input, Suggestion: plan.Correction.Suggestion, Items: items}, nil
}

func (s *Service) englishSuggestionsForMatches(ctx context.Context, matches []englishsearch.Match) ([]suggestion, error) {
	if len(matches) == 0 {
		return []suggestion{}, nil
	}
	ids := make([]string, 0, len(matches))
	for _, match := range matches {
		if match.Kind != englishsearch.MatchEtymology && match.EntryID != "" {
			ids = append(ids, match.EntryID)
		}
	}
	byID, err := s.dictionarySuggestionsForIDs(ctx, ids)
	if err != nil {
		return nil, err
	}
	results := make([]suggestion, 0, len(matches))
	positions := make(map[string]int, len(matches))
	for rank, match := range matches {
		key := "dictionary:" + match.EntryID
		if match.Kind == englishsearch.MatchEtymology {
			key = "etymology:" + match.EntryID
		}
		if index, exists := positions[key]; exists {
			if evidence, ok := englishSearchMatch(match); ok {
				results[index].Matches = append(results[index].Matches, evidence)
				results[index].MatchesTotal = len(results[index].Matches)
			}
			continue
		}
		var item suggestion
		if match.Kind == englishsearch.MatchEtymology {
			item = suggestion{ID: match.EntryID, Kind: "etymology", Headword: match.Headword, PartsOfSpeech: []string{}}
		} else {
			var exists bool
			item, exists = byID[match.EntryID]
			if !exists {
				continue
			}
		}
		item.rank = rank
		if evidence, ok := englishSearchMatch(match); ok {
			item.Matches = []searchMatch{evidence}
			item.MatchesTotal = 1
		}
		positions[key] = len(results)
		results = append(results, item)
	}
	sortSuggestions(results)
	return results, nil
}

func englishSearchMatch(match englishsearch.Match) (searchMatch, bool) {
	switch match.Kind {
	case englishsearch.MatchHeadword, englishsearch.MatchEtymology:
		return searchMatch{}, false
	case englishsearch.MatchPhrase, englishsearch.MatchPattern:
		if match.Evidence == nil {
			return searchMatch{}, false
		}
		evidence := match.Evidence
		return searchMatch{
			Scope: reversesearch.Scope(evidence.Scope), EnglishText: evidence.CandidateText,
			CandidateText: evidence.CandidateText, DefinitionText: evidence.DefinitionText,
			ChineseText: evidence.ChineseText, Part: evidence.Location.Part,
			SemanticRole: reversesearch.SemanticRole(evidence.SemanticRole), MatchKind: match.Kind,
			Location: reversesearch.Location{
				Section: reversesearch.Section(evidence.Location.Section), Part: evidence.Location.Part,
				OwnerID: evidence.Location.OwnerID, Path: append([]string(nil), evidence.Location.Path...),
			},
		}, true
	default:
		return searchMatch{
			Scope: reversesearch.ScopeForm, EnglishText: match.Display,
			ChineseText: "", MatchKind: match.Kind, Relation: match.Relation,
			Location: reversesearch.Location{Section: reversesearch.SectionDefinitions, Path: []string{}},
		}, true
	}
}

func englishPlanItems(groups []englishSearchGroup, limit int) []suggestion {
	items := make([]suggestion, 0, limit)
	seen := make(map[string]struct{}, limit)
	for _, group := range groups {
		for _, item := range group.Items {
			key := item.Kind + ":" + item.ID
			if _, exists := seen[key]; exists {
				continue
			}
			seen[key] = struct{}{}
			items = append(items, item)
			if len(items) == limit {
				return items
			}
		}
	}
	return items
}

func isEnglishPlannerError(err error) bool {
	return errors.Is(err, englishsearch.ErrEmptyQuery) || errors.Is(err, englishsearch.ErrQueryLong)
}
