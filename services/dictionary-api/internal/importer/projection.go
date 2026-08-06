package importer

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"unicode"
)

const (
	maxPartsOfSpeech     = 8
	maxPartOfSpeechRunes = 32
	maxTranslationRunes  = 120
)

type searchProjection struct {
	PartsOfSpeech      []string
	TranslationPreview string
}

type jsonKind uint8

const (
	jsonNull jsonKind = iota
	jsonScalar
	jsonArray
	jsonObject
)

type jsonValue struct {
	kind   jsonKind
	scalar string
	array  []jsonValue
	object []jsonMember
}

type jsonMember struct {
	key   string
	value jsonValue
}

func extractSearchProjection(raw []byte) (searchProjection, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	root, err := decodeJSONValue(decoder)
	if err != nil {
		return searchProjection{}, err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return searchProjection{}, errTrailingJSON
	}

	projection := searchProjection{PartsOfSpeech: make([]string, 0, maxPartsOfSpeech)}
	seenParts := make(map[string]struct{}, maxPartsOfSpeech)
	var visit func(jsonValue)
	visit = func(value jsonValue) {
		switch value.kind {
		case jsonArray:
			for _, item := range value.array {
				visit(item)
			}
		case jsonObject:
			for _, member := range value.object {
				switch member.key {
				case "pos":
					for _, part := range projectionTexts(member.value) {
						part = truncateRunes(strings.TrimSpace(part), maxPartOfSpeechRunes)
						if part == "" || len(projection.PartsOfSpeech) == maxPartsOfSpeech {
							continue
						}
						if _, exists := seenParts[part]; !exists {
							seenParts[part] = struct{}{}
							projection.PartsOfSpeech = append(projection.PartsOfSpeech, part)
						}
					}
				case "def_simp":
					if projection.TranslationPreview == "" {
						preview := strings.TrimSpace(projectionText(member.value))
						if containsHan(preview) {
							projection.TranslationPreview = truncateRunes(preview, maxTranslationRunes)
						}
					}
				}
				visit(member.value)
			}
		}
	}
	visit(root)
	return projection, nil
}

var errTrailingJSON = errors.New("unexpected trailing JSON value")

func decodeJSONValue(decoder *json.Decoder) (jsonValue, error) {
	token, err := decoder.Token()
	if err != nil {
		return jsonValue{}, err
	}
	switch token := token.(type) {
	case json.Delim:
		switch token {
		case '{':
			value := jsonValue{kind: jsonObject}
			for decoder.More() {
				key, err := decoder.Token()
				if err != nil {
					return jsonValue{}, err
				}
				child, err := decodeJSONValue(decoder)
				if err != nil {
					return jsonValue{}, err
				}
				value.object = append(value.object, jsonMember{key: key.(string), value: child})
			}
			if _, err := decoder.Token(); err != nil {
				return jsonValue{}, err
			}
			return value, nil
		case '[':
			value := jsonValue{kind: jsonArray}
			for decoder.More() {
				child, err := decodeJSONValue(decoder)
				if err != nil {
					return jsonValue{}, err
				}
				value.array = append(value.array, child)
			}
			if _, err := decoder.Token(); err != nil {
				return jsonValue{}, err
			}
			return value, nil
		}
		return jsonValue{}, errors.New("invalid JSON delimiter")
	case string:
		return jsonValue{kind: jsonScalar, scalar: token}, nil
	case json.Number:
		return jsonValue{kind: jsonScalar, scalar: token.String()}, nil
	default:
		return jsonValue{kind: jsonNull}, nil
	}
}

func projectionTexts(value jsonValue) []string {
	if value.kind != jsonArray {
		return []string{projectionText(value)}
	}
	texts := make([]string, 0, len(value.array))
	for _, item := range value.array {
		texts = append(texts, projectionText(item))
	}
	return texts
}

func projectionText(value jsonValue) string {
	switch value.kind {
	case jsonScalar:
		return value.scalar
	case jsonArray:
		var text strings.Builder
		for _, item := range value.array {
			text.WriteString(projectionText(item))
		}
		return text.String()
	case jsonObject:
		for _, member := range value.object {
			if member.key == "value" {
				return projectionText(member.value)
			}
		}
		var text strings.Builder
		for _, key := range []string{"eng", "simp", "text", "word", "name", "def_eng", "def_simp"} {
			for _, member := range value.object {
				if member.key == key {
					text.WriteString(projectionText(member.value))
				}
			}
		}
		return text.String()
	default:
		return ""
	}
}

func containsHan(value string) bool {
	for _, runeValue := range value {
		if unicode.Is(unicode.Han, runeValue) {
			return true
		}
	}
	return false
}

func truncateRunes(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}
