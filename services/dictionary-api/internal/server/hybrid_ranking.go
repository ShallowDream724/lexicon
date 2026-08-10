package server

import (
	"math"
	"sort"
	"strings"
)

// Semantic similarities inside one query are reliable in order but noisy at
// very small distances. Evidence in the same band is resolved by the next
// strongest match, which prevents verbose entries from accumulating a score.
const (
	semanticEvidenceBand = 0.005
	protectedLexicalTier = 2
)

type hybridSuggestion struct {
	item            suggestion
	lexicalRank     int
	semanticRank    int
	lexicalTier     int
	semanticProfile []int
}

func mergeHybridSuggestions(lexical, semantic []suggestion) []suggestion {
	byID := make(map[string]*hybridSuggestion, len(lexical)+len(semantic))
	for rank, item := range lexical {
		item.Matches = rankSearchMatches(item.Matches)
		item.MatchesTotal = len(item.Matches)
		byID[item.ID] = &hybridSuggestion{
			item: item, lexicalRank: rank, semanticRank: hybridResultWindow,
		}
	}
	for rank, item := range semantic {
		candidate, exists := byID[item.ID]
		if !exists {
			item.Matches = rankSearchMatches(item.Matches)
			item.MatchesTotal = len(item.Matches)
			byID[item.ID] = &hybridSuggestion{
				item: item, lexicalRank: hybridResultWindow, semanticRank: rank,
			}
			continue
		}
		candidate.semanticRank = rank
		candidate.item.Matches = mergeSearchMatches(candidate.item.Matches, item.Matches)
		candidate.item.MatchesTotal = len(candidate.item.Matches)
	}

	merged := make([]hybridSuggestion, 0, len(byID))
	for _, candidate := range byID {
		candidate.lexicalTier = strongestLexicalTier(candidate.item.Matches)
		candidate.semanticProfile = semanticEvidenceProfile(candidate.item.Matches)
		merged = append(merged, *candidate)
	}
	sort.SliceStable(merged, func(left, right int) bool {
		return compareHybridSuggestions(merged[left], merged[right]) < 0
	})

	results := make([]suggestion, len(merged))
	for index, candidate := range merged {
		candidate.item.rank = index
		results[index] = candidate.item
	}
	return results
}

func compareHybridSuggestions(left, right hybridSuggestion) int {
	leftStrong, rightStrong := left.lexicalTier >= protectedLexicalTier, right.lexicalTier >= protectedLexicalTier
	if leftStrong != rightStrong {
		if leftStrong {
			return -1
		}
		return 1
	}
	if leftStrong {
		if left.lexicalTier != right.lexicalTier {
			return compareDescending(left.lexicalTier, right.lexicalTier)
		}
		if left.lexicalRank != right.lexicalRank {
			return compareAscending(left.lexicalRank, right.lexicalRank)
		}
		if order := compareProfiles(left.semanticProfile, right.semanticProfile); order != 0 {
			return order
		}
	} else {
		leftSemantic, rightSemantic := len(left.semanticProfile) > 0, len(right.semanticProfile) > 0
		if leftSemantic != rightSemantic {
			if leftSemantic {
				return -1
			}
			return 1
		}
		if order := compareProfiles(left.semanticProfile, right.semanticProfile); order != 0 {
			return order
		}
		if left.semanticRank != right.semanticRank {
			return compareAscending(left.semanticRank, right.semanticRank)
		}
		if left.lexicalRank != right.lexicalRank {
			return compareAscending(left.lexicalRank, right.lexicalRank)
		}
	}
	return strings.Compare(left.item.ID, right.item.ID)
}

func compareProfiles(left, right []int) int {
	limit := min(len(left), len(right))
	for index := 0; index < limit; index++ {
		if left[index] != right[index] {
			return compareDescending(left[index], right[index])
		}
	}
	// Only an equal leading profile reaches this point, so one additional strong
	// match acts as corroboration without ever beating a better first match.
	return compareDescending(len(left), len(right))
}

func strongestLexicalTier(matches []searchMatch) int {
	strongest := 0
	for _, match := range matches {
		if match.hasLexical && match.lexicalRelevance.Tier > strongest {
			strongest = match.lexicalRelevance.Tier
		}
	}
	return strongest
}

func semanticEvidenceProfile(matches []searchMatch) []int {
	profile := make([]int, 0, len(matches))
	for _, match := range matches {
		if match.hasSemantic {
			profile = append(profile, int(math.Round(float64(match.semanticScore)/semanticEvidenceBand)))
		}
	}
	sort.Sort(sort.Reverse(sort.IntSlice(profile)))
	return profile
}

func mergeSearchMatches(groups ...[]searchMatch) []searchMatch {
	unique := make(map[string]searchMatch, maxSearchMatches)
	for _, matches := range groups {
		for _, match := range matches {
			key := searchMatchKey(match)
			if current, exists := unique[key]; exists {
				unique[key] = combineSearchMatch(current, match)
			} else {
				unique[key] = match
			}
		}
	}
	result := make([]searchMatch, 0, len(unique))
	for _, match := range unique {
		result = append(result, match)
	}
	result = rankSearchMatches(result)
	if len(result) > maxSearchMatches {
		result = result[:maxSearchMatches]
	}
	return result
}

func combineSearchMatch(current, incoming searchMatch) searchMatch {
	if incoming.CandidateText != "" {
		current.CandidateText = incoming.CandidateText
	}
	if incoming.DefinitionText != "" {
		current.DefinitionText = incoming.DefinitionText
	}
	if incoming.Part != "" {
		current.Part = incoming.Part
	}
	if incoming.hasLexical {
		if !current.hasLexical || incoming.lexicalRelevance.Tier > current.lexicalRelevance.Tier ||
			(incoming.lexicalRelevance.Tier == current.lexicalRelevance.Tier && incoming.lexicalPosition < current.lexicalPosition) {
			current.lexicalPosition = incoming.lexicalPosition
			current.lexicalRelevance = incoming.lexicalRelevance
		}
		current.hasLexical = true
	}
	if incoming.hasSemantic {
		if !current.hasSemantic || incoming.semanticScore > current.semanticScore ||
			(incoming.semanticScore == current.semanticScore && incoming.semanticPosition < current.semanticPosition) {
			current.semanticPosition = incoming.semanticPosition
			current.semanticScore = incoming.semanticScore
		}
		current.hasSemantic = true
	}
	return current
}

func rankSearchMatches(matches []searchMatch) []searchMatch {
	result := append([]searchMatch(nil), matches...)
	sort.SliceStable(result, func(left, right int) bool {
		return compareSearchMatches(result[left], result[right]) < 0
	})
	if len(result) > maxSearchMatches {
		result = result[:maxSearchMatches]
	}
	return result
}

func compareSearchMatches(left, right searchMatch) int {
	leftStrong := left.hasLexical && left.lexicalRelevance.Tier >= protectedLexicalTier
	rightStrong := right.hasLexical && right.lexicalRelevance.Tier >= protectedLexicalTier
	if leftStrong != rightStrong {
		if leftStrong {
			return -1
		}
		return 1
	}
	if leftStrong {
		if left.lexicalRelevance.Tier != right.lexicalRelevance.Tier {
			return compareDescending(left.lexicalRelevance.Tier, right.lexicalRelevance.Tier)
		}
		if left.lexicalPosition != right.lexicalPosition {
			return compareAscending(left.lexicalPosition, right.lexicalPosition)
		}
	}
	if left.hasSemantic != right.hasSemantic {
		if left.hasSemantic {
			return -1
		}
		return 1
	}
	if left.hasSemantic && left.semanticScore != right.semanticScore {
		if left.semanticScore > right.semanticScore {
			return -1
		}
		return 1
	}
	if left.hasLexical != right.hasLexical {
		if left.hasLexical {
			return -1
		}
		return 1
	}
	if left.hasLexical {
		if left.lexicalRelevance.Tier != right.lexicalRelevance.Tier {
			return compareDescending(left.lexicalRelevance.Tier, right.lexicalRelevance.Tier)
		}
		if left.lexicalPosition != right.lexicalPosition {
			return compareAscending(left.lexicalPosition, right.lexicalPosition)
		}
	}
	return strings.Compare(searchMatchKey(left), searchMatchKey(right))
}

func searchMatchKey(match searchMatch) string {
	return strings.Join([]string{
		string(match.Scope), match.EnglishText, match.ChineseText,
		string(match.Location.Section), match.Location.Part, match.Location.OwnerID,
		strings.Join(match.Location.Path, "\x1f"),
	}, "\x00")
}

func compareAscending(left, right int) int {
	if left < right {
		return -1
	}
	if left > right {
		return 1
	}
	return 0
}

func compareDescending(left, right int) int { return compareAscending(right, left) }
