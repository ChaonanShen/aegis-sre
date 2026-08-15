package raglite

type Collection struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	FolderUID string `json:"folder_uid"`
	Scope     string `json:"scope"`
	Status    string `json:"status"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

type Document struct {
	ID            string   `json:"id"`
	CollectionID  string   `json:"collection_id"`
	Name          string   `json:"name"`
	MediaType     string   `json:"media_type"`
	Size          int64    `json:"size"`
	SHA256        string   `json:"sha256"`
	OriginalPath  string   `json:"original_path"`
	Service       string   `json:"service"`
	Tags          []string `json:"tags"`
	Status        string   `json:"status"`
	FailureReason string   `json:"failure_reason"`
	CreatedAt     string   `json:"created_at"`
	UpdatedAt     string   `json:"updated_at"`
}

type Job struct {
	ID         string `json:"id"`
	DocumentID string `json:"document_id"`
	Operation  string `json:"operation"`
	Status     string `json:"status"`
}

type Chunk struct {
	ID           string `json:"id"`
	DocumentID   string `json:"document_id"`
	CollectionID string `json:"collection_id"`
	SourceName   string `json:"source_name"`
	Text         string `json:"text"`
	Position     string `json:"position"`
	PageNumber   int    `json:"page_number"`
}

type SearchHit struct {
	Chunk Chunk   `json:"chunk"`
	Score float64 `json:"score"`
}

type listCollectionsResponse struct {
	Items []Collection `json:"items"`
	Total int          `json:"total"`
}
type listDocumentsResponse struct {
	Items []Document `json:"items"`
	Total int        `json:"total"`
}
type listChunksResponse struct {
	Items []Chunk `json:"items"`
	Total int     `json:"total"`
}
type searchResponse struct {
	Hits []SearchHit `json:"hits"`
}
type problem struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	Retryable bool   `json:"retryable"`
}
