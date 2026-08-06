package media

import (
	"errors"
	"fmt"
	"net/url"
	"strings"
)

type Kind string

const (
	ExampleAudio          Kind = "example-audio"
	Illustration          Kind = "illustration"
	IllustrationThumbnail Kind = "illustration-thumbnail"
)

var (
	ErrUnavailable = errors.New("media source is unavailable")
	ErrInvalidKey  = errors.New("media key is invalid")
)

type source struct {
	baseURL     string
	extension   string
	urlTemplate string
}

type Resolver struct {
	sources map[Kind]source
}

func NewResolver(baseURLs map[Kind]string) (*Resolver, error) {
	return NewResolverWithTemplates(baseURLs, nil)
}

func NewResolverWithTemplates(baseURLs, urlTemplates map[Kind]string) (*Resolver, error) {
	sources := make(map[Kind]source)
	kinds := make(map[Kind]struct{}, len(baseURLs)+len(urlTemplates))
	for kind := range baseURLs {
		kinds[kind] = struct{}{}
	}
	for kind := range urlTemplates {
		kinds[kind] = struct{}{}
	}
	for kind := range kinds {
		if _, known := extensionFor(kind); !known {
			return nil, fmt.Errorf("unsupported media kind %q", kind)
		}
		rawBaseURL := strings.TrimSpace(baseURLs[kind])
		rawTemplate := strings.TrimSpace(urlTemplates[kind])
		if rawBaseURL != "" && rawTemplate != "" {
			return nil, fmt.Errorf("configure either %s media base URL or URL template", kind)
		}
		if rawTemplate != "" {
			if err := validateURLTemplate(rawTemplate); err != nil {
				return nil, fmt.Errorf("invalid %s media URL template: %w", kind, err)
			}
			sources[kind] = source{urlTemplate: rawTemplate}
			continue
		}
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
	if source.urlTemplate != "" {
		return expandURLTemplate(source.urlTemplate, key), nil
	}
	return source.baseURL + url.PathEscape(key) + source.extension, nil
}

func validateURLTemplate(rawTemplate string) error {
	if !strings.Contains(rawTemplate, "{key}") {
		return errors.New("template must contain {key}")
	}
	schemeEnd := strings.Index(rawTemplate, "://")
	if schemeEnd < 1 {
		return errors.New("template must expand to an HTTP or HTTPS URL")
	}
	authorityStart := schemeEnd + 3
	pathOffset := strings.IndexByte(rawTemplate[authorityStart:], '/')
	if pathOffset < 0 {
		return errors.New("{key} must be in the URL path")
	}
	pathStart := authorityStart + pathOffset
	pathEnd := len(rawTemplate)
	if suffixStart := strings.IndexAny(rawTemplate[pathStart:], "?#"); suffixStart >= 0 {
		pathEnd = pathStart + suffixStart
	}
	pathTemplate := rawTemplate[pathStart:pathEnd]
	if !strings.Contains(pathTemplate, "{key}") {
		return errors.New("{key} must be in the URL path")
	}
	for _, placeholder := range []string{"{key}", "{prefix1}", "{prefix3}", "{prefix5}"} {
		if strings.Count(rawTemplate, placeholder) != strings.Count(pathTemplate, placeholder) {
			return errors.New("template placeholders are allowed only in the URL path")
		}
	}
	expanded := expandURLTemplate(rawTemplate, "sample-key")
	if strings.ContainsAny(expanded, "{}") {
		return errors.New("template contains an unsupported placeholder")
	}
	parsed, err := url.Parse(expanded)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" {
		return errors.New("template must expand to an HTTP or HTTPS URL")
	}
	return nil
}

func expandURLTemplate(urlTemplate, key string) string {
	runes := []rune(strings.ToLower(key))
	prefix := func(length int) string {
		if length > len(runes) {
			length = len(runes)
		}
		return url.PathEscape(string(runes[:length]))
	}
	return strings.NewReplacer(
		"{prefix1}", prefix(1),
		"{prefix3}", prefix(3),
		"{prefix5}", prefix(5),
		"{key}", url.PathEscape(key),
	).Replace(urlTemplate)
}

func extensionFor(kind Kind) (string, bool) {
	switch kind {
	case ExampleAudio:
		return ".wav", true
	case Illustration, IllustrationThumbnail:
		return ".jpg", true
	default:
		return "", false
	}
}
