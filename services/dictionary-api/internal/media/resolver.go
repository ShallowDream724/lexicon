package media

import (
	"errors"
	"fmt"
	"net/url"
	"strings"
)

type Kind string

const (
	ExampleAudio Kind = "example-audio"
	Illustration Kind = "illustration"
)

var (
	ErrUnavailable = errors.New("media source is unavailable")
	ErrInvalidKey  = errors.New("media key is invalid")
)

type source struct {
	baseURL   string
	extension string
}

type Resolver struct {
	sources map[Kind]source
}

func NewResolver(baseURLs map[Kind]string) (*Resolver, error) {
	sources := make(map[Kind]source)
	for kind, rawBaseURL := range baseURLs {
		rawBaseURL = strings.TrimSpace(rawBaseURL)
		if rawBaseURL == "" {
			continue
		}
		parsed, err := url.Parse(rawBaseURL)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
			return nil, fmt.Errorf("invalid %s media base URL", kind)
		}
		extension, known := extensionFor(kind)
		if !known {
			return nil, fmt.Errorf("unsupported media kind %q", kind)
		}
		parsed.Path = strings.TrimRight(parsed.Path, "/") + "/"
		parsed.RawPath = ""
		sources[kind] = source{baseURL: parsed.String(), extension: extension}
	}
	return &Resolver{sources: sources}, nil
}

func (r *Resolver) Resolve(kind Kind, key string) (string, error) {
	if r == nil {
		return "", ErrUnavailable
	}
	source, ok := r.sources[kind]
	if !ok {
		return "", ErrUnavailable
	}
	if key == "" || len(key) > 512 || strings.ContainsAny(key, "/\\") || key == "." || key == ".." {
		return "", ErrInvalidKey
	}
	return source.baseURL + url.PathEscape(key) + source.extension, nil
}

func extensionFor(kind Kind) (string, bool) {
	switch kind {
	case ExampleAudio:
		return ".wav", true
	case Illustration:
		return ".jpg", true
	default:
		return "", false
	}
}
