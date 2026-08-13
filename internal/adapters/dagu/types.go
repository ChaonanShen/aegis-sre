package dagu

import "encoding/json"

type DAGFile struct {
	FileName string `json:"fileName"`
	DAG      struct {
		Name        string   `json:"name"`
		Description string   `json:"description"`
		Labels      []string `json:"labels"`
	} `json:"dag"`
	Suspended bool `json:"suspended"`
}

type DAGDetails struct {
	DAG       json.RawMessage `json:"dag"`
	Spec      string          `json:"spec"`
	Suspended bool            `json:"suspended"`
	Errors    []string        `json:"errors"`
}

type ValidationResult struct {
	Valid  bool     `json:"valid"`
	Errors []string `json:"errors"`
}

type DAGRun struct {
	DAGRunID   string          `json:"dagRunId"`
	Name       string          `json:"name"`
	Status     int             `json:"status"`
	StatusText string          `json:"statusLabel"`
	StartedAt  string          `json:"startedAt"`
	FinishedAt string          `json:"finishedAt"`
	Nodes      json.RawMessage `json:"nodes"`
}

type Artifact struct {
	Name     string     `json:"name"`
	Path     string     `json:"path"`
	Type     string     `json:"type"`
	Size     int64      `json:"size"`
	Children []Artifact `json:"children,omitempty"`
}

type ArtifactPreview struct {
	Path      string `json:"path"`
	Content   string `json:"content"`
	MIMEType  string `json:"mimeType"`
	Truncated bool   `json:"truncated"`
}
