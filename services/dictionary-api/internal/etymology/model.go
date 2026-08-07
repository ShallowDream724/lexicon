// Package etymology provides the immutable sidecar projection for etymology data.
package etymology

const (
	SchemaVersion        = "1.0"
	SidecarSchemaVersion = 3
	sidecarVersionDate   = "2026-08-07T00:00:00Z"
	Kind                 = "etymology"
)

type Link struct {
	TargetTerm      string `json:"targetTerm"`
	TargetArticleID string `json:"targetArticleId,omitempty"`
}

type TextRun struct {
	Text  string   `json:"text"`
	Marks []string `json:"marks"`
	Link  *Link    `json:"link,omitempty"`
}

type Block struct {
	Kind string    `json:"kind"`
	Runs []TextRun `json:"runs"`
}

type Document struct {
	Blocks []Block `json:"blocks"`
}

type ArticleSummary struct {
	ID          string    `json:"id"`
	Label       string    `json:"label"`
	Preview     string    `json:"preview"`
	PreviewRuns []TextRun `json:"previewRuns"`
}

type Article struct {
	ID       string   `json:"id"`
	Label    string   `json:"label"`
	Preview  string   `json:"preview"`
	Document Document `json:"document"`
}

type ResourceSummary struct {
	SchemaVersion string           `json:"schemaVersion"`
	Kind          string           `json:"kind"`
	ResourceID    string           `json:"resourceId"`
	SourceVersion string           `json:"sourceVersion"`
	Term          string           `json:"term"`
	Headword      string           `json:"headword"`
	Articles      []ArticleSummary `json:"articles"`
}

type ArticleResponse struct {
	SchemaVersion string  `json:"schemaVersion"`
	Kind          string  `json:"kind"`
	ResourceID    string  `json:"resourceId"`
	SourceVersion string  `json:"sourceVersion"`
	Term          string  `json:"term"`
	Headword      string  `json:"headword"`
	Article       Article `json:"article"`
}

type SearchResult struct {
	Term     string
	Headword string
}

func resourceID(term string) string { return Kind + ":" + term }
