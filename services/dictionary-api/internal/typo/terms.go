// Package typo builds bounded candidates for one-edit dictionary corrections.
package typo

const (
	MinTermLength       = 3
	MaxTermLength       = 64
	MaxSearchSignatures = MaxTermLength + 1
	MaxDirectCandidates = MaxTermLength*2 - 1
)

// Eligible reports whether a normalized term can use typo correction.
func Eligible(term string) bool {
	if len(term) < MinTermLength || len(term) > MaxTermLength {
		return false
	}
	for index := 0; index < len(term); index++ {
		if term[index] < 'a' || term[index] > 'z' {
			return false
		}
	}
	return true
}

// DeleteSignatures returns the unique terms formed by deleting one byte. It is
// used while importing terms into the deletion-signature index.
func DeleteSignatures(term string) []string {
	if !Eligible(term) {
		return nil
	}
	return uniqueDeletes(term)
}

// SearchSignatures returns the original term followed by its one-delete
// signatures. They cover a missing character and a replacement through the
// deletion-signature index.
func SearchSignatures(term string) []string {
	if !Eligible(term) {
		return nil
	}
	signatures := make([]string, 0, MaxSearchSignatures)
	signatures = append(signatures, term)
	signatures = append(signatures, uniqueDeletes(term)...)
	return signatures
}

// DirectCandidates returns adjacent transpositions followed by one-delete
// terms. They are exact lookups against the primary term index.
func DirectCandidates(term string) []string {
	if !Eligible(term) {
		return nil
	}
	candidates := make([]string, 0, MaxDirectCandidates)
	seen := make(map[string]struct{}, MaxDirectCandidates)
	add := func(candidate string) {
		if _, exists := seen[candidate]; exists {
			return
		}
		seen[candidate] = struct{}{}
		candidates = append(candidates, candidate)
	}
	for index := 0; index+1 < len(term); index++ {
		if term[index] == term[index+1] {
			continue
		}
		candidate := term[:index] + string(term[index+1]) + string(term[index]) + term[index+2:]
		add(candidate)
	}
	for _, candidate := range uniqueDeletes(term) {
		add(candidate)
	}
	return candidates
}

func uniqueDeletes(term string) []string {
	deletes := make([]string, 0, len(term))
	seen := make(map[string]struct{}, len(term))
	for index := 0; index < len(term); index++ {
		candidate := term[:index] + term[index+1:]
		if _, exists := seen[candidate]; exists {
			continue
		}
		seen[candidate] = struct{}{}
		deletes = append(deletes, candidate)
	}
	return deletes
}
