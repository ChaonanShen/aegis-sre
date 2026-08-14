package ragflow

import "encoding/json"

type Dataset struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Status      string `json:"status"`
	CreateTime  int64  `json:"create_time"`
	UpdateTime  int64  `json:"update_time"`
}

type Document struct {
	ID          string          `json:"id"`
	Name        string          `json:"name"`
	Location    string          `json:"location"`
	Run         string          `json:"run"`
	Size        int64           `json:"size"`
	ProgressMsg json.RawMessage `json:"progress_msg"`
	MetaFields  map[string]any  `json:"meta_fields"`
	CreateTime  int64           `json:"create_time"`
	UpdateTime  int64           `json:"update_time"`
}

type Chunk struct {
	ID         string `json:"id"`
	DocumentID string `json:"document_id"`
	Content    string `json:"content"`
	DocName    string `json:"docnm_kwd"`
	Positions  []any  `json:"positions"`
}

type RetrievalChunk struct {
	ID              string  `json:"id"`
	DocumentID      string  `json:"document_id"`
	DocumentKeyword string  `json:"document_keyword"`
	KnowledgeBaseID string  `json:"kb_id"`
	Content         string  `json:"content"`
	Similarity      float64 `json:"similarity"`
	Positions       []any   `json:"positions"`
}

type ListDatasetsResult struct {
	Items []Dataset
	Total int
}

type ListDocumentsResult struct {
	Items []Document
	Total int
}

type ListChunksResult struct {
	Items []Chunk
	Total int
}

type RetrievalResult struct {
	Chunks []RetrievalChunk
	Total  int
}
