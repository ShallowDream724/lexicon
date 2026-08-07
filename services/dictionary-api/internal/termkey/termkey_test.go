package termkey

import (
	"reflect"
	"testing"
)

func TestDictionaryAndEnhancementKeysPreserveMeaningfulPunctuation(t *testing.T) {
	if got := Dictionary("  Ter·ri‧bly  "); got != "terribly" {
		t.Fatalf("dictionary key = %q", got)
	}
	if got := Dictionary("Adam’s Apple"); got != "adam’s apple" {
		t.Fatalf("dictionary apostrophe = %q", got)
	}
	if got := Enhancement("Adam’s Apple"); got != "adam's apple" {
		t.Fatalf("enhancement apostrophe = %q", got)
	}
	if got := Enhancement("re-search™"); got != "re-search™" {
		t.Fatalf("meaningful punctuation changed: %q", got)
	}
}

func TestDictionaryQueryVariantsBoundLegacyApostropheLookups(t *testing.T) {
	want := []string{"adam’s apple", "adam's apple"}
	if got := DictionaryQueryVariants("Adam’s Apple"); !reflect.DeepEqual(got, want) {
		t.Fatalf("variants = %q, want %q", got, want)
	}
	if got := DictionaryQueryVariants("terribly"); !reflect.DeepEqual(got, []string{"terribly"}) {
		t.Fatalf("plain variants = %q", got)
	}
}
