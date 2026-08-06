package typo

import (
	"strings"
	"testing"
)

func TestCandidatesAreBoundedForMaximumEligibleTerm(t *testing.T) {
	term := strings.Repeat("a", MaxTermLength-1) + "b"
	if !Eligible(term) {
		t.Fatal("maximum-length ASCII term is not eligible")
	}
	if got := len(SearchSignatures(term)); got > MaxSearchSignatures {
		t.Fatalf("search signatures = %d, max = %d", got, MaxSearchSignatures)
	}
	if got := len(DirectCandidates(term)); got > MaxDirectCandidates {
		t.Fatalf("direct candidates = %d, max = %d", got, MaxDirectCandidates)
	}
}

func TestEligibleRejectsTermsOutsideCorrectionContract(t *testing.T) {
	for _, term := range []string{"ab", "two words", "grateful!", strings.Repeat("a", MaxTermLength+1)} {
		if Eligible(term) {
			t.Fatalf("Eligible(%q) = true", term)
		}
	}
}
