package server

import (
	"sort"
	"strings"

	"dictionary-api/internal/reversesearch"
	"dictionary-api/internal/semanticsearch"
)

// Semantic similarities inside one query are reliable in order but noisy at
// very small distances. Evidence in the same band is resolved by the next
// strongest match, which prevents verbose entries from accumulating a score.
const protectedLexicalTier = 3

type hybridSuggestion struct {
	item                      suggestion
	lexicalRank               int
	semanticRank              int
	lexicalTier               int
	semanticProfile           []semanticEvidence
	answerableSemanticProfile []semanticEvidence
}

type evidenceQueryProfile interface {
	EvidenceHits(values ...string) (significantHits, allHits int)
}

func mergeHybridSuggestions(profile evidenceQueryProfile, lexical, semantic []suggestion) []suggestion {
	byID := make(map[string]*hybridSuggestion, len(lexical)+len(semantic))
	for rank, item := range lexical {
		item.Matches = rankSearchMatches(profile, item.Matches)
		item.MatchesTotal = len(item.Matches)
		byID[item.ID] = &hybridSuggestion{
			item: item, lexicalRank: rank, semanticRank: hybridResultWindow,
		}
	}
	for rank, item := range semantic {
		candidate, exists := byID[item.ID]
		if !exists {
			item.Matches = rankSearchMatches(profile, item.Matches)
			item.MatchesTotal = len(item.Matches)
			byID[item.ID] = &hybridSuggestion{
				item: item, lexicalRank: hybridResultWindow, semanticRank: rank,
			}
			continue
		}
		candidate.semanticRank = rank
		candidate.item.Matches = mergeSearchMatches(profile, candidate.item.Matches, item.Matches)
		candidate.item.MatchesTotal = len(candidate.item.Matches)
	}

	merged := make([]hybridSuggestion, 0, len(byID))
	for _, candidate := range byID {
		candidate.lexicalTier = strongestLexicalTier(candidate.item.Matches)
		candidate.semanticProfile = semanticEvidenceProfile(profile, candidate.item.Matches)
		candidate.answerableSemanticProfile = answerableSemanticEvidenceProfile(candidate.semanticProfile)
		merged = append(merged, *candidate)
	}
	sort.SliceStable(merged, func(left, right int) bool {
		return compareHybridSuggestions(profile, merged[left], merged[right]) < 0
	})

	results := make([]suggestion, len(merged))
	for index, candidate := range merged {
		candidate.item.rank = index
		results[index] = candidate.item
	}
	return results
}

func compareHybridSuggestions(profile evidenceQueryProfile, left, right hybridSuggestion) int {
	if left.item.headwordAnchor != right.item.headwordAnchor {
		if left.item.headwordAnchor {
			return -1
		}
		return 1
	}
	if left.item.headwordAnchor {
		if order := compareProfiles(profile, left.answerableSemanticProfile, right.answerableSemanticProfile); order != 0 {
			return order
		}
		if left.item.headwordAnchorRank != right.item.headwordAnchorRank {
			return compareAscending(left.item.headwordAnchorRank, right.item.headwordAnchorRank)
		}
		if left.lexicalRank != right.lexicalRank {
			return compareAscending(left.lexicalRank, right.lexicalRank)
		}
	}
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
		if order := compareProfiles(profile, left.semanticProfile, right.semanticProfile); order != 0 {
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
		if order := compareProfiles(profile, left.semanticProfile, right.semanticProfile); order != 0 {
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

func compareProfiles(profile evidenceQueryProfile, left, right []semanticEvidence) int {
	limit := min(len(left), len(right))
	for index := 0; index < limit; index++ {
		if order := compareSemanticEvidenceQuality(profile, left[index], right[index]); order != 0 {
			return order
		}
	}
	// Only an equal leading profile reaches this point, so one additional strong
	// match acts as corroboration without ever beating a better first match.
	if order := compareDescending(len(left), len(right)); order != 0 {
		return order
	}
	for index := 0; index < limit; index++ {
		if left[index].score != right[index].score {
			if left[index].score > right[index].score {
				return -1
			}
			return 1
		}
	}
	return 0
}

func strongestLexicalTier(matches []searchMatch) int {
	strongest := 0
	for _, match := range matches {
		if protectsLexicalResult(match) && match.lexicalRelevance.Tier > strongest {
			strongest = match.lexicalRelevance.Tier
		}
	}
	return strongest
}

func protectsLexicalResult(match searchMatch) bool {
	if !match.hasLexical || match.lexicalRelevance.Tier < protectedLexicalTier {
		return false
	}
	switch match.lexicalSemanticRole {
	case reversesearch.SemanticRoleDefinition, reversesearch.SemanticRoleGuidance:
		return true
	default:
		return false
	}
}

type semanticEvidence struct {
	score                  float32
	retrievalAnswerability int
	evidenceAnswerability  int
	significantTokenHits   int
	allTokenHits           int
	key                    string
}

func semanticEvidenceProfile(queryProfile evidenceQueryProfile, matches []searchMatch) []semanticEvidence {
	evidence := make([]semanticEvidence, 0, len(matches))
	for _, match := range matches {
		if match.hasSemantic {
			evidence = append(evidence, semanticEvidenceFromMatch(queryProfile, match))
		}
	}
	sort.SliceStable(evidence, func(left, right int) bool {
		return compareSemanticEvidenceForRetrieval(queryProfile, evidence[left], evidence[right]) < 0
	})
	return evidence
}

func answerableSemanticEvidenceProfile(profile []semanticEvidence) []semanticEvidence {
	answerable := make([]semanticEvidence, 0, len(profile))
	for _, evidence := range profile {
		if evidence.retrievalAnswerability >= 2 {
			answerable = append(answerable, evidence)
		}
	}
	return answerable
}

func compareSemanticEvidenceForRetrieval(profile evidenceQueryProfile, left, right semanticEvidence) int {
	if order := compareSemanticEvidenceQuality(profile, left, right); order != 0 {
		return order
	}
	if left.score != right.score {
		if left.score > right.score {
			return -1
		}
		return 1
	}
	return strings.Compare(left.key, right.key)
}

func compareSemanticEvidenceForDisplay(profile evidenceQueryProfile, left, right semanticEvidence) int {
	leftBand, rightBand := semanticsearch.EvidenceBand(left.score), semanticsearch.EvidenceBand(right.score)
	if leftBand != rightBand {
		return compareDescending(leftBand, rightBand)
	}
	if order := compareDescending(left.retrievalAnswerability, right.retrievalAnswerability); order != 0 {
		return order
	}
	if evidenceSupportsQueryAwareOrder(left, right) {
		if order := compareEvidenceTokenHits(left, right); order != 0 {
			return order
		}
	}
	if left.evidenceAnswerability != right.evidenceAnswerability {
		return compareDescending(left.evidenceAnswerability, right.evidenceAnswerability)
	}
	if left.score != right.score {
		if left.score > right.score {
			return -1
		}
		return 1
	}
	return strings.Compare(left.key, right.key)
}

func compareSemanticEvidenceQuality(profile evidenceQueryProfile, left, right semanticEvidence) int {
	leftBand, rightBand := semanticsearch.EvidenceBand(left.score), semanticsearch.EvidenceBand(right.score)
	if leftBand != rightBand {
		return compareDescending(leftBand, rightBand)
	}
	if evidenceSupportsQueryAwareOrder(left, right) {
		if order := compareEvidenceTokenHits(left, right); order != 0 {
			return order
		}
	}
	return compareDescending(left.retrievalAnswerability, right.retrievalAnswerability)
}

func semanticEvidenceFromMatch(profile evidenceQueryProfile, match searchMatch) semanticEvidence {
	significantTokenHits, allTokenHits := evidenceTokenHits(profile, match)
	return semanticEvidence{
		score:                  match.semanticScore,
		retrievalAnswerability: searchMatchRetrievalAnswerability(match),
		evidenceAnswerability:  searchMatchEvidenceAnswerability(match),
		significantTokenHits:   significantTokenHits,
		allTokenHits:           allTokenHits,
		key:                    searchMatchKey(match),
	}
}

func evidenceTokenHits(profile evidenceQueryProfile, match searchMatch) (int, int) {
	return match.querySignificantHits, match.queryAllHits
}

func evidenceSupportsQueryAwareOrder(left, right semanticEvidence) bool {
	return left.retrievalAnswerability >= 2 && right.retrievalAnswerability >= 2
}

func compareEvidenceTokenHits(left, right semanticEvidence) int {
	if order := compareDescending(left.significantTokenHits, right.significantTokenHits); order != 0 {
		return order
	}
	return compareDescending(left.allTokenHits, right.allTokenHits)
}

func searchMatchRetrievalAnswerability(match searchMatch) int {
	priority := -1
	if match.hasLexical && match.lexicalSemanticRole.RetrievalPriority() > priority {
		priority = match.lexicalSemanticRole.RetrievalPriority()
	}
	if match.hasSemantic && match.semanticSemanticRole.RetrievalPriority() > priority {
		priority = match.semanticSemanticRole.RetrievalPriority()
	}
	return priority
}

func searchMatchEvidenceAnswerability(match searchMatch) int {
	priority := -1
	if match.hasLexical && match.lexicalSemanticRole.EvidencePriority() > priority {
		priority = match.lexicalSemanticRole.EvidencePriority()
	}
	if match.hasSemantic && match.semanticSemanticRole.EvidencePriority() > priority {
		priority = match.semanticSemanticRole.EvidencePriority()
	}
	return priority
}

func mergeSearchMatches(profile evidenceQueryProfile, groups ...[]searchMatch) []searchMatch {
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
	result = rankSearchMatches(profile, result)
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
		if incoming.lexicalSemanticRole.EvidencePriority() > current.lexicalSemanticRole.EvidencePriority() {
			current.lexicalSemanticRole = incoming.lexicalSemanticRole
		}
		current.hasLexical = true
	}
	if incoming.hasSemantic {
		if !current.hasSemantic || compareSemanticMatches(nil, incoming, current) < 0 {
			current.semanticPosition = incoming.semanticPosition
			current.semanticScore = incoming.semanticScore
			current.semanticSemanticRole = incoming.semanticSemanticRole
		}
		current.hasSemantic = true
	}
	return current
}

func rankSearchMatches(profile evidenceQueryProfile, matches []searchMatch) []searchMatch {
	result := append([]searchMatch(nil), matches...)
	populateSearchMatchTokenHits(profile, result)
	sort.SliceStable(result, func(left, right int) bool {
		return compareSearchMatches(profile, result[left], result[right]) < 0
	})
	if len(result) > maxSearchMatches {
		result = result[:maxSearchMatches]
	}
	return result
}

func populateSearchMatchTokenHits(profile evidenceQueryProfile, matches []searchMatch) {
	for index := range matches {
		matches[index].querySignificantHits, matches[index].queryAllHits = 0, 0
		if profile == nil {
			continue
		}
		matches[index].querySignificantHits, matches[index].queryAllHits = profile.EvidenceHits(
			matches[index].EnglishText,
			matches[index].CandidateText,
			matches[index].DefinitionText,
		)
	}
}

func compareSearchMatches(profile evidenceQueryProfile, left, right searchMatch) int {
	leftAnswerable, rightAnswerable := searchMatchRetrievalAnswerability(left) >= 2, searchMatchRetrievalAnswerability(right) >= 2
	if leftAnswerable != rightAnswerable {
		leftQualified := left.hasSemantic || (left.hasLexical && left.lexicalRelevance.Tier >= protectedLexicalTier)
		rightQualified := right.hasSemantic || (right.hasLexical && right.lexicalRelevance.Tier >= protectedLexicalTier)
		if leftAnswerable && leftQualified {
			return -1
		}
		if rightAnswerable && rightQualified {
			return 1
		}
	}
	leftStrong := protectsLexicalResult(left)
	rightStrong := protectsLexicalResult(right)
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
		if order := compareSearchMatchTokenHits(profile, left, right); order != 0 {
			return order
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
	if left.hasSemantic {
		if order := compareSemanticMatches(profile, left, right); order != 0 {
			return order
		}
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
		if order := compareSearchMatchTokenHits(profile, left, right); order != 0 {
			return order
		}
		if left.lexicalPosition != right.lexicalPosition {
			return compareAscending(left.lexicalPosition, right.lexicalPosition)
		}
	}
	return strings.Compare(searchMatchKey(left), searchMatchKey(right))
}

func compareSearchMatchTokenHits(profile evidenceQueryProfile, left, right searchMatch) int {
	if !searchMatchSupportsQueryAwareOrder(left) || !searchMatchSupportsQueryAwareOrder(right) {
		return 0
	}
	leftSignificant, leftAll := evidenceTokenHits(profile, left)
	rightSignificant, rightAll := evidenceTokenHits(profile, right)
	return compareEvidenceTokenHits(
		semanticEvidence{significantTokenHits: leftSignificant, allTokenHits: leftAll},
		semanticEvidence{significantTokenHits: rightSignificant, allTokenHits: rightAll},
	)
}

func searchMatchSupportsQueryAwareOrder(match searchMatch) bool {
	return searchMatchRetrievalAnswerability(match) >= 2 &&
		(match.hasSemantic || (match.hasLexical && match.lexicalRelevance.Tier >= protectedLexicalTier))
}

func compareSemanticMatches(profile evidenceQueryProfile, left, right searchMatch) int {
	return compareSemanticEvidenceForDisplay(profile, semanticEvidenceFromMatch(profile, left), semanticEvidenceFromMatch(profile, right))
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
