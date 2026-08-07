package termkey

import "strings"

var syllableSeparators = strings.NewReplacer(
	"·", "",
	"‧", "",
)

var typographicApostrophes = strings.NewReplacer(
	"‘", "'",
	"’", "'",
	"‛", "'",
	"＇", "'",
)

// Dictionary returns the stable lookup key used by the primary dictionary.
func Dictionary(value string) string {
	return strings.ToLower(syllableSeparators.Replace(strings.TrimSpace(value)))
}

// Enhancement returns the source-neutral key used to associate optional resources.
func Enhancement(value string) string {
	return typographicApostrophes.Replace(Dictionary(value))
}

// DictionaryQueryVariants keeps indexed lookups compatible with runtime databases
// created before typographic apostrophes were normalized at the association boundary.
func DictionaryQueryVariants(value string) []string {
	primary := Dictionary(value)
	canonical := Enhancement(value)
	curly := strings.ReplaceAll(canonical, "'", "’")
	variants := make([]string, 0, 3)
	for _, candidate := range []string{primary, canonical, curly} {
		if candidate == "" || contains(variants, candidate) {
			continue
		}
		variants = append(variants, candidate)
	}
	return variants
}

func contains(values []string, candidate string) bool {
	for _, value := range values {
		if value == candidate {
			return true
		}
	}
	return false
}
