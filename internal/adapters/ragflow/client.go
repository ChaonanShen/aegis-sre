// Package ragflow adapts the pinned RAGFlow HTTP API. Wire types stay inside this package.
package ragflow

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const maxResponseBytes = 8 << 20

type TokenSource func() (string, error)

type Client struct {
	baseURL      *url.URL
	httpClient   *http.Client
	tokenSource  TokenSource
	readAttempts int
}

type ClientOptions struct {
	HTTPClient   *http.Client
	ReadAttempts int
}

// ProviderError intentionally excludes the upstream body and message.
type ProviderError struct {
	StatusCode int
	Code       int
	Retryable  bool
	Unknown    bool
	cause      error
}

func (err *ProviderError) Error() string { return "knowledge provider request failed" }
func (err *ProviderError) Unwrap() error { return err.cause }

func NewClient(rawURL string, tokenSource TokenSource, options ClientOptions) (*Client, error) {
	baseURL, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || baseURL.Scheme == "" || baseURL.Host == "" {
		return nil, errors.New("valid RAGFlow URL is required")
	}
	if tokenSource == nil {
		return nil, errors.New("RAGFlow token source is required")
	}
	client := options.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 30 * time.Second}
	}
	attempts := options.ReadAttempts
	if attempts <= 0 {
		attempts = 2
	}
	return &Client{baseURL: baseURL, httpClient: client, tokenSource: tokenSource, readAttempts: attempts}, nil
}

func (client *Client) ListDatasets(ctx context.Context, page, pageSize int, name string) (ListDatasetsResult, error) {
	query := url.Values{"page": {strconv.Itoa(page)}, "page_size": {strconv.Itoa(pageSize)}, "orderby": {"update_time"}, "desc": {"true"}}
	if name != "" {
		query.Set("name", name)
	}
	var payload struct {
		Code          int       `json:"code"`
		Data          []Dataset `json:"data"`
		TotalDatasets int       `json:"total_datasets"`
	}
	if err := client.doJSON(ctx, http.MethodGet, "/api/v1/datasets?"+query.Encode(), nil, &payload, false); err != nil {
		return ListDatasetsResult{}, err
	}
	if payload.Code != 0 {
		return ListDatasetsResult{}, &ProviderError{Code: payload.Code}
	}
	return ListDatasetsResult{Items: payload.Data, Total: payload.TotalDatasets}, nil
}

func (client *Client) CreateDataset(ctx context.Context, name, description, embeddingModel string) (Dataset, error) {
	body := map[string]any{"name": name, "description": description, "permission": "me", "chunk_method": "naive"}
	if embeddingModel != "" {
		body["embedding_model"] = embeddingModel
	}
	var data Dataset
	if err := client.doDataJSON(ctx, http.MethodPost, "/api/v1/datasets", body, &data, true); err != nil {
		return Dataset{}, err
	}
	return data, nil
}

func (client *Client) UpdateDataset(ctx context.Context, id, description, status string) error {
	body := map[string]any{"description": description}
	if status != "" {
		body["status"] = status
	}
	return client.doJSON(ctx, http.MethodPut, "/api/v1/datasets/"+url.PathEscape(id), body, nil, true)
}

func (client *Client) DeleteDataset(ctx context.Context, id string) error {
	return client.doJSON(ctx, http.MethodDelete, "/api/v1/datasets", map[string]any{"ids": []string{id}}, nil, true)
}

func (client *Client) ListDocuments(ctx context.Context, datasetID string, page, pageSize int, name string) (ListDocumentsResult, error) {
	query := url.Values{"page": {strconv.Itoa(page)}, "page_size": {strconv.Itoa(pageSize)}, "orderby": {"update_time"}, "desc": {"true"}}
	if name != "" {
		query.Set("name", name)
	}
	var data struct {
		Docs  []Document `json:"docs"`
		Total int        `json:"total"`
	}
	path := "/api/v1/datasets/" + url.PathEscape(datasetID) + "/documents?" + query.Encode()
	if err := client.doDataJSON(ctx, http.MethodGet, path, nil, &data, false); err != nil {
		return ListDocumentsResult{}, err
	}
	return ListDocumentsResult{Items: data.Docs, Total: data.Total}, nil
}

func (client *Client) UploadDocument(ctx context.Context, datasetID, name, mediaType string, content io.Reader) ([]Document, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	partHeader := make(textproto.MIMEHeader)
	partHeader.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename="%s"`, escapeQuotes(name)))
	partHeader.Set("Content-Type", mediaType)
	part, err := writer.CreatePart(partHeader)
	if err != nil {
		return nil, err
	}
	if _, err := io.Copy(part, content); err != nil {
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	var data []Document
	path := "/api/v1/datasets/" + url.PathEscape(datasetID) + "/documents"
	if err := client.do(ctx, http.MethodPost, path, &body, writer.FormDataContentType(), &data, true, true); err != nil {
		return nil, err
	}
	return data, nil
}

func escapeQuotes(value string) string {
	return strings.NewReplacer("\\", "_", "\"", "_").Replace(value)
}

func (client *Client) UpdateDocument(ctx context.Context, datasetID, documentID string, metadata map[string]any) error {
	path := "/api/v1/datasets/" + url.PathEscape(datasetID) + "/documents/" + url.PathEscape(documentID)
	return client.doJSON(ctx, http.MethodPut, path, map[string]any{"meta_fields": metadata}, nil, true)
}

func (client *Client) DeleteDocument(ctx context.Context, datasetID, documentID string) error {
	path := "/api/v1/datasets/" + url.PathEscape(datasetID) + "/documents"
	return client.doJSON(ctx, http.MethodDelete, path, map[string]any{"ids": []string{documentID}}, nil, true)
}

func (client *Client) StartIndexing(ctx context.Context, datasetID, documentID string) error {
	path := "/api/v1/datasets/" + url.PathEscape(datasetID) + "/chunks"
	return client.doJSON(ctx, http.MethodPost, path, map[string]any{"document_ids": []string{documentID}}, nil, true)
}

func (client *Client) StopIndexing(ctx context.Context, datasetID, documentID string) error {
	path := "/api/v1/datasets/" + url.PathEscape(datasetID) + "/chunks"
	return client.doJSON(ctx, http.MethodDelete, path, map[string]any{"document_ids": []string{documentID}}, nil, true)
}

func (client *Client) ListChunks(ctx context.Context, datasetID, documentID string, page, pageSize int) (ListChunksResult, error) {
	query := url.Values{"page": {strconv.Itoa(page)}, "page_size": {strconv.Itoa(pageSize)}}
	path := "/api/v1/datasets/" + url.PathEscape(datasetID) + "/documents/" + url.PathEscape(documentID) + "/chunks?" + query.Encode()
	var data struct {
		Chunks []Chunk `json:"chunks"`
		Total  int     `json:"total"`
	}
	if err := client.doDataJSON(ctx, http.MethodGet, path, nil, &data, false); err != nil {
		return ListChunksResult{}, err
	}
	return ListChunksResult{Items: data.Chunks, Total: data.Total}, nil
}

func (client *Client) Retrieve(ctx context.Context, datasetIDs []string, question string, pageSize int, threshold float64, metadata map[string]any) (RetrievalResult, error) {
	body := map[string]any{"question": question, "dataset_ids": datasetIDs, "page": 1, "page_size": pageSize, "similarity_threshold": threshold}
	if metadata != nil {
		body["metadata_condition"] = metadata
	}
	var data struct {
		Chunks []RetrievalChunk `json:"chunks"`
		Total  int              `json:"total"`
	}
	if err := client.doDataJSON(ctx, http.MethodPost, "/api/v1/retrieval", body, &data, false); err != nil {
		return RetrievalResult{}, err
	}
	return RetrievalResult{Chunks: data.Chunks, Total: data.Total}, nil
}

func (client *Client) DownloadDocument(ctx context.Context, datasetID, documentID string) (*http.Response, error) {
	path := "/api/v1/datasets/" + url.PathEscape(datasetID) + "/documents/" + url.PathEscape(documentID)
	return client.doRaw(ctx, http.MethodGet, path)
}

func (client *Client) doDataJSON(ctx context.Context, method, path string, body, target any, mutation bool) error {
	var envelope struct {
		Code    int             `json:"code"`
		Data    json.RawMessage `json:"data"`
		Message string          `json:"message"`
	}
	if err := client.do(ctx, method, path, body, "application/json", &envelope, mutation, false); err != nil {
		return err
	}
	if envelope.Code != 0 {
		return &ProviderError{Code: envelope.Code}
	}
	if target != nil && len(envelope.Data) > 0 && string(envelope.Data) != "null" {
		if err := json.Unmarshal(envelope.Data, target); err != nil {
			return &ProviderError{cause: err}
		}
	}
	return nil
}

func (client *Client) doJSON(ctx context.Context, method, path string, body, target any, mutation bool) error {
	if target == nil {
		return client.doDataJSON(ctx, method, path, body, nil, mutation)
	}
	return client.do(ctx, method, path, body, "application/json", target, mutation, false)
}

func (client *Client) do(ctx context.Context, method, path string, body any, contentType string, target any, mutation, rawBody bool) error {
	var encoded []byte
	var err error
	if body != nil {
		if reader, ok := body.(io.Reader); ok {
			encoded, err = io.ReadAll(reader)
		} else {
			encoded, err = json.Marshal(body)
		}
		if err != nil {
			return err
		}
	}
	attempts := 1
	if method == http.MethodGet && !mutation {
		attempts = client.readAttempts
	}
	for attempt := 1; attempt <= attempts; attempt++ {
		request, requestErr := client.newRequest(ctx, method, path, bytes.NewReader(encoded), contentType)
		if requestErr != nil {
			return requestErr
		}
		response, requestErr := client.httpClient.Do(request)
		if requestErr != nil {
			if attempt < attempts && ctx.Err() == nil {
				continue
			}
			return classifyTransportError(requestErr, mutation)
		}
		if response.StatusCode >= 500 && attempt < attempts {
			_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maxResponseBytes))
			_ = response.Body.Close()
			continue
		}
		defer response.Body.Close()
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maxResponseBytes))
			return &ProviderError{StatusCode: response.StatusCode, Retryable: response.StatusCode >= 500, Unknown: mutation && response.StatusCode >= 500}
		}
		limited := io.LimitReader(response.Body, maxResponseBytes+1)
		payload, readErr := io.ReadAll(limited)
		if readErr != nil {
			return classifyTransportError(readErr, mutation)
		}
		if len(payload) > maxResponseBytes {
			return &ProviderError{cause: errors.New("provider response exceeds limit")}
		}
		if rawBody {
			var envelope struct {
				Code int `json:"code"`
			}
			if err := json.Unmarshal(payload, &envelope); err != nil {
				return &ProviderError{cause: err}
			}
			if envelope.Code != 0 {
				return &ProviderError{Code: envelope.Code}
			}
			data := json.RawMessage(payload)
			if target != nil {
				var wrapped struct {
					Data json.RawMessage `json:"data"`
				}
				if err := json.Unmarshal(payload, &wrapped); err != nil {
					return &ProviderError{cause: err}
				}
				data = wrapped.Data
			}
			if target != nil && len(data) > 0 {
				if err := json.Unmarshal(data, target); err != nil {
					return &ProviderError{cause: err}
				}
			}
			return nil
		}
		if target != nil && len(payload) > 0 {
			if err := json.Unmarshal(payload, target); err != nil {
				return &ProviderError{cause: err}
			}
		}
		return nil
	}
	return &ProviderError{Retryable: true}
}

func (client *Client) doRaw(ctx context.Context, method, path string) (*http.Response, error) {
	request, err := client.newRequest(ctx, method, path, nil, "")
	if err != nil {
		return nil, err
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return nil, classifyTransportError(err, false)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maxResponseBytes))
		_ = response.Body.Close()
		return nil, &ProviderError{StatusCode: response.StatusCode, Retryable: response.StatusCode >= 500}
	}
	return response, nil
}

func (client *Client) newRequest(ctx context.Context, method, path string, body io.Reader, contentType string) (*http.Request, error) {
	token, err := client.tokenSource()
	if err != nil || strings.TrimSpace(token) == "" {
		return nil, &ProviderError{cause: errors.New("provider credential unavailable")}
	}
	endpoint := client.baseURL.ResolveReference(&url.URL{Path: strings.SplitN(path, "?", 2)[0]})
	if queryIndex := strings.IndexByte(path, '?'); queryIndex >= 0 {
		endpoint.RawQuery = path[queryIndex+1:]
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint.String(), body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+strings.TrimSpace(token))
	request.Header.Set("Accept", "application/json")
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	return request, nil
}

func classifyTransportError(err error, mutation bool) error {
	providerErr := &ProviderError{cause: err, Retryable: !mutation, Unknown: mutation}
	if errors.Is(err, context.DeadlineExceeded) {
		providerErr.Retryable = !mutation
	}
	return providerErr
}
