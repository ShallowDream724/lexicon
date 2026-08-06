package importer

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestExtractSearchProjection(t *testing.T) {
	longChinese := strings.Repeat("汉", maxTranslationRunes+1)
	tests := []struct {
		name string
		body string
		want searchProjection
	}{
		{
			name: "missing fields",
			body: `{"top_data":{"h":[{"value":"empty"}]}}`,
			want: searchProjection{PartsOfSpeech: []string{}, TranslationPreview: ""},
		},
		{
			name: "tokens multiple parts and first Chinese definition",
			body: `{"pos":[{"value":"noun"},{"value":"verb"},{"value":"noun"}],"sn_g":[{"def_simp":[{"value":"English only"},{"value":""}]},{"def_simp":[{"tag":"simp","value":"首个中文释义"}]}]}`,
			want: searchProjection{PartsOfSpeech: []string{"noun", "verb"}, TranslationPreview: "首个中文释义"},
		},
		{
			name: "nested subentries retain local text without joining fields",
			body: `{"sngs_data":[{"id":"sub-entry","pos":[{"value":{"text":"adjective"}}],"sn_g":[{"def_simp":[{"value":"嵌套释义"}]}]}]}`,
			want: searchProjection{PartsOfSpeech: []string{"adjective"}, TranslationPreview: "嵌套释义"},
		},
		{
			name: "rune bounded Chinese preview",
			body: `{"def_simp":{"value":"` + longChinese + `"}}`,
			want: searchProjection{PartsOfSpeech: []string{}, TranslationPreview: strings.Repeat("汉", maxTranslationRunes)},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := extractSearchProjection([]byte(test.body))
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, test.want) {
				t.Fatalf("projection = %#v, want %#v", got, test.want)
			}
		})
	}
}

func TestExtractSearchProjectionBoundsPartsOfSpeech(t *testing.T) {
	parts := make([]map[string]string, maxPartsOfSpeech+1)
	for index := range parts {
		parts[index] = map[string]string{"value": strings.Repeat(string(rune('a'+index)), maxPartOfSpeechRunes+1)}
	}
	body, err := json.Marshal(map[string]any{"pos": parts})
	if err != nil {
		t.Fatal(err)
	}

	projection, err := extractSearchProjection(body)
	if err != nil {
		t.Fatal(err)
	}
	if len(projection.PartsOfSpeech) != maxPartsOfSpeech {
		t.Fatalf("parts count = %d, want %d", len(projection.PartsOfSpeech), maxPartsOfSpeech)
	}
	for _, part := range projection.PartsOfSpeech {
		if len([]rune(part)) != maxPartOfSpeechRunes {
			t.Fatalf("part %q has %d runes, want %d", part, len([]rune(part)), maxPartOfSpeechRunes)
		}
	}
}

func TestExtractSearchProjectionIsDeterministic(t *testing.T) {
	body := []byte(`{"z":{"pos":{"value":"late"}},"a":{"pos":{"value":"early"},"def_simp":{"value":"稳定结果"}}}`)
	want, err := extractSearchProjection(body)
	if err != nil {
		t.Fatal(err)
	}
	for range 100 {
		got, err := extractSearchProjection(body)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("projection = %#v, want %#v", got, want)
		}
	}
}
