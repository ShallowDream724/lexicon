package semanticsearch

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Embedder interface {
	Embed(context.Context, string, string, []byte) ([]float32, error)
	ModelKey() string
	Dimensions() int
}

type EmbedErrorKind string

const (
	EmbedErrorConfiguration EmbedErrorKind = "configuration"
	EmbedErrorRequest       EmbedErrorKind = "request"
	EmbedErrorResponse      EmbedErrorKind = "response"
)

type EmbedError struct {
	Kind EmbedErrorKind
	Err  error
}

func (e *EmbedError) Error() string {
	return "semantic embedding " + string(e.Kind) + " error: " + e.Err.Error()
}
func (e *EmbedError) Unwrap() error { return e.Err }

type OpenAIEmbedderConfig struct {
	BaseURL    string
	APIKey     string
	Model      string
	ModelKey   string
	Dimensions int
	Timeout    time.Duration
}

type OpenAIEmbedder struct {
	endpoint   string
	apiKey     string
	model      string
	modelKey   string
	dimensions int
	timeout    time.Duration
	client     *http.Client
}

func NewOpenAIEmbedder(config OpenAIEmbedderConfig) (*OpenAIEmbedder, error) {
	if strings.TrimSpace(config.APIKey) == "" || strings.TrimSpace(config.Model) == "" || strings.TrimSpace(config.ModelKey) == "" || config.Dimensions < 1 {
		return nil, &EmbedError{Kind: EmbedErrorConfiguration, Err: errors.New("API key, model, model key, and dimensions are required")}
	}
	base, err := url.Parse(strings.TrimSpace(config.BaseURL))
	if err != nil || base.Scheme == "" || base.Host == "" {
		return nil, &EmbedError{Kind: EmbedErrorConfiguration, Err: errors.New("base URL is invalid")}
	}
	base.Path = embeddingsPath(base.Path)
	base.RawQuery, base.Fragment = "", ""
	timeout := config.Timeout
	if timeout <= 0 {
		timeout = 3 * time.Second
	}
	return &OpenAIEmbedder{endpoint: base.String(), apiKey: config.APIKey, model: config.Model, modelKey: config.ModelKey, dimensions: config.Dimensions, timeout: timeout, client: &http.Client{}}, nil
}

func embeddingsPath(path string) string {
	path = strings.TrimRight(path, "/")
	switch {
	case strings.HasSuffix(path, "/v1/embeddings"):
		return path
	case strings.HasSuffix(path, "/v1"):
		return path + "/embeddings"
	default:
		return path + "/v1/embeddings"
	}
}

func (e *OpenAIEmbedder) ModelKey() string {
	if e == nil {
		return ""
	}
	return e.modelKey
}
func (e *OpenAIEmbedder) Dimensions() int {
	if e == nil {
		return 0
	}
	return e.dimensions
}

func (e *OpenAIEmbedder) Embed(ctx context.Context, query, queryTemplate string, queryExtraJSON []byte) ([]float32, error) {
	if e == nil || e.client == nil {
		return nil, &EmbedError{Kind: EmbedErrorConfiguration, Err: errors.New("embedder is not configured")}
	}
	input, err := renderQueryTemplate(queryTemplate, query)
	if err != nil {
		return nil, &EmbedError{Kind: EmbedErrorConfiguration, Err: err}
	}
	if err := validateQueryExtraJSON(queryExtraJSON); err != nil {
		return nil, &EmbedError{Kind: EmbedErrorConfiguration, Err: err}
	}
	requestPayload := map[string]json.RawMessage{}
	if err := json.Unmarshal(queryExtraJSON, &requestPayload); err != nil {
		return nil, &EmbedError{Kind: EmbedErrorConfiguration, Err: errors.New("query extra JSON is invalid")}
	}
	inputJSON, err := json.Marshal(input)
	if err != nil {
		return nil, &EmbedError{Kind: EmbedErrorRequest, Err: errors.New("encode embedding input")}
	}
	modelJSON, err := json.Marshal(e.model)
	if err != nil {
		return nil, &EmbedError{Kind: EmbedErrorRequest, Err: errors.New("encode embedding model")}
	}
	dimensionsJSON, err := json.Marshal(e.dimensions)
	if err != nil {
		return nil, &EmbedError{Kind: EmbedErrorRequest, Err: errors.New("encode embedding dimensions")}
	}
	requestPayload["input"] = inputJSON
	requestPayload["model"] = modelJSON
	requestPayload["encoding_format"] = json.RawMessage(`"float"`)
	requestPayload["dimensions"] = dimensionsJSON
	body, err := json.Marshal(requestPayload)
	if err != nil {
		return nil, &EmbedError{Kind: EmbedErrorRequest, Err: errors.New("encode embedding request")}
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, e.endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, &EmbedError{Kind: EmbedErrorRequest, Err: errors.New("create embedding request")}
	}
	request.Header.Set("Authorization", "Bearer "+e.apiKey)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("User-Agent", "Lexicon-Dictionary-API/1")
	requestContext, cancel := context.WithTimeout(request.Context(), e.timeout)
	defer cancel()
	response, err := e.client.Do(request.WithContext(requestContext))
	if err != nil {
		return nil, &EmbedError{Kind: EmbedErrorRequest, Err: err}
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return nil, &EmbedError{Kind: EmbedErrorResponse, Err: fmt.Errorf("embedding provider returned HTTP %d", response.StatusCode)}
	}
	var payload struct {
		Data []struct {
			Index     int       `json:"index"`
			Embedding []float32 `json:"embedding"`
		} `json:"data"`
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 4<<20))
	if err := decoder.Decode(&payload); err != nil {
		return nil, &EmbedError{Kind: EmbedErrorResponse, Err: errors.New("embedding provider returned an invalid response")}
	}
	if len(payload.Data) != 1 || payload.Data[0].Index != 0 || len(payload.Data[0].Embedding) != e.dimensions {
		return nil, &EmbedError{Kind: EmbedErrorResponse, Err: errors.New("embedding provider returned an invalid vector shape")}
	}
	vector, err := normalizeEmbedding(payload.Data[0].Embedding)
	if err != nil {
		return nil, &EmbedError{Kind: EmbedErrorResponse, Err: err}
	}
	return vector, nil
}

func renderQueryTemplate(template, query string) (string, error) {
	if err := validateQueryTemplate(template); err != nil {
		return "", err
	}
	if strings.TrimSpace(query) == "" {
		return "", errors.New("semantic-search query must not be empty")
	}
	return strings.Replace(template, "{query}", query, 1), nil
}

func validateQueryTemplate(template string) error {
	if strings.TrimSpace(template) == "" || strings.Count(template, "{query}") != 1 {
		return errors.New("query template must contain exactly one {query} placeholder")
	}
	remaining := strings.Replace(template, "{query}", "", 1)
	if strings.ContainsAny(remaining, "{}") {
		return errors.New("query template contains an unsupported placeholder")
	}
	return nil
}

func normalizeEmbedding(vector []float32) ([]float32, error) {
	var sum float64
	for _, value := range vector {
		if math.IsNaN(float64(value)) || math.IsInf(float64(value), 0) {
			return nil, errors.New("embedding provider returned a non-finite vector")
		}
		sum += float64(value) * float64(value)
	}
	if sum == 0 || math.IsNaN(sum) || math.IsInf(sum, 0) {
		return nil, errors.New("embedding provider returned a zero vector")
	}
	norm := float32(math.Sqrt(sum))
	result := make([]float32, len(vector))
	for index, value := range vector {
		result[index] = value / norm
	}
	return result, nil
}
