// Package raglite adapts the internal RAGLite Provider REST API.
package raglite

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
	"strings"
	"time"
)

const maxResponseBytes = 8 << 20

type TokenSource func() (string, error)

type ProviderError struct {
	StatusCode int
	Code       string
	Retryable  bool
	Unknown    bool
	cause      error
}

func (err *ProviderError) Error() string { return "knowledge provider request failed" }
func (err *ProviderError) Unwrap() error { return err.cause }

type Client struct {
	baseURL     *url.URL
	httpClient  *http.Client
	tokenSource TokenSource
}

func NewClient(rawURL string, tokenSource TokenSource, httpClient *http.Client) (*Client, error) {
	baseURL, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || baseURL.Scheme == "" || baseURL.Host == "" {
		return nil, errors.New("valid RAGLite Provider URL is required")
	}
	if tokenSource == nil {
		return nil, errors.New("RAGLite Provider token source is required")
	}
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}
	return &Client{baseURL: baseURL, httpClient: httpClient, tokenSource: tokenSource}, nil
}

func (c *Client) Check(ctx context.Context) error {
	return c.doJSON(ctx, http.MethodGet, "/healthz", "", nil, nil, false)
}
func (c *Client) ListCollections(ctx context.Context, scope, folder string) ([]Collection, error) {
	var out listCollectionsResponse
	err := c.doJSON(ctx, http.MethodGet, "/v1/collections?"+url.Values{"folder_uid": {folder}}.Encode(), scope, nil, &out, false)
	return out.Items, err
}
func (c *Client) GetCollection(ctx context.Context, scope, id string) (Collection, error) {
	var out Collection
	err := c.doJSON(ctx, http.MethodGet, "/v1/collections/"+url.PathEscape(id), scope, nil, &out, false)
	return out, err
}
func (c *Client) CreateCollection(ctx context.Context, scope string, in Collection) (Collection, error) {
	var out Collection
	err := c.doJSON(ctx, http.MethodPost, "/v1/collections", scope, map[string]any{"id": in.ID, "name": in.Name, "folder_uid": in.FolderUID}, &out, true)
	return out, err
}
func (c *Client) UpdateCollection(ctx context.Context, scope, id, name, state string) (Collection, error) {
	var out Collection
	err := c.doJSON(ctx, http.MethodPatch, "/v1/collections/"+url.PathEscape(id), scope, map[string]any{"name": name, "status": state}, &out, true)
	return out, err
}
func (c *Client) MigrateCollectionScope(ctx context.Context, sourceScope, id, targetScope string) (Collection, error) {
	var out Collection
	err := c.doJSON(ctx, http.MethodPost, "/v1/collections/"+url.PathEscape(id)+"/scope-migrations", sourceScope, map[string]any{"target_scope": targetScope}, &out, true)
	return out, err
}
func (c *Client) DeleteCollection(ctx context.Context, scope, id string) error {
	return c.doJSON(ctx, http.MethodDelete, "/v1/collections/"+url.PathEscape(id), scope, nil, nil, true)
}
func (c *Client) ListDocuments(ctx context.Context, scope, collectionID string) ([]Document, error) {
	var out listDocumentsResponse
	err := c.doJSON(ctx, http.MethodGet, "/v1/collections/"+url.PathEscape(collectionID)+"/documents", scope, nil, &out, false)
	return out.Items, err
}
func (c *Client) GetDocument(ctx context.Context, scope, id string) (Document, error) {
	var out Document
	err := c.doJSON(ctx, http.MethodGet, "/v1/documents/"+url.PathEscape(id), scope, nil, &out, false)
	return out, err
}
func (c *Client) UploadDocument(ctx context.Context, scope, collectionID, documentID, name, mediaType, service string, tags []string, content io.Reader) (Document, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("id", documentID); err != nil {
		return Document{}, err
	}
	if err := writer.WriteField("service", service); err != nil {
		return Document{}, err
	}
	encodedTags, err := json.Marshal(tags)
	if err != nil {
		return Document{}, err
	}
	if err := writer.WriteField("tags", string(encodedTags)); err != nil {
		return Document{}, err
	}
	header := make(textproto.MIMEHeader)
	header.Set("Content-Disposition", fmt.Sprintf(`form-data; name="file"; filename="%s"`, escapeQuotes(name)))
	header.Set("Content-Type", mediaType)
	part, err := writer.CreatePart(header)
	if err != nil {
		return Document{}, err
	}
	if _, err = io.Copy(part, content); err != nil {
		return Document{}, err
	}
	if err = writer.Close(); err != nil {
		return Document{}, err
	}
	var out Document
	path := "/v1/collections/" + url.PathEscape(collectionID) + "/documents"
	err = c.do(ctx, http.MethodPost, path, scope, body.Bytes(), writer.FormDataContentType(), &out, true)
	return out, err
}
func (c *Client) UpdateDocument(ctx context.Context, scope, id, service string, tags []string) (Document, error) {
	var out Document
	err := c.doJSON(ctx, http.MethodPatch, "/v1/documents/"+url.PathEscape(id), scope, map[string]any{"service": service, "tags": tags}, &out, true)
	return out, err
}
func (c *Client) DeleteDocument(ctx context.Context, scope, id string) error {
	return c.doJSON(ctx, http.MethodDelete, "/v1/documents/"+url.PathEscape(id), scope, nil, nil, true)
}
func (c *Client) StartIndexing(ctx context.Context, scope, id string) (Job, error) {
	var out Job
	err := c.doJSON(ctx, http.MethodPost, "/v1/documents/"+url.PathEscape(id)+":index", scope, nil, &out, true)
	return out, err
}
func (c *Client) StopIndexing(ctx context.Context, scope, id string) error {
	return c.doJSON(ctx, http.MethodPost, "/v1/documents/"+url.PathEscape(id)+":stop", scope, nil, nil, true)
}
func (c *Client) ListChunks(ctx context.Context, scope, id string) ([]Chunk, error) {
	var out listChunksResponse
	err := c.doJSON(ctx, http.MethodGet, "/v1/documents/"+url.PathEscape(id)+"/chunks", scope, nil, &out, false)
	return out.Items, err
}
func (c *Client) Search(ctx context.Context, scope, query string, collections []string, service string, limit int, threshold float64) ([]SearchHit, error) {
	var out searchResponse
	body := map[string]any{"query": query, "collections": collections, "service": service, "limit": limit, "threshold": threshold}
	err := c.doJSON(ctx, http.MethodPost, "/v1/search", scope, body, &out, false)
	return out.Hits, err
}
func (c *Client) DownloadDocument(ctx context.Context, scope, id string) (*http.Response, error) {
	return c.doRaw(ctx, http.MethodGet, "/v1/documents/"+url.PathEscape(id)+"/content", scope)
}

func (c *Client) doJSON(ctx context.Context, method, path, scope string, body, target any, mutation bool) error {
	var encoded []byte
	var err error
	if body != nil {
		encoded, err = json.Marshal(body)
		if err != nil {
			return err
		}
	}
	return c.do(ctx, method, path, scope, encoded, "application/json", target, mutation)
}
func (c *Client) do(ctx context.Context, method, path, scope string, body []byte, contentType string, target any, mutation bool) error {
	request, err := c.newRequest(ctx, method, path, scope, bytes.NewReader(body), contentType)
	if err != nil {
		return err
	}
	response, err := c.httpClient.Do(request)
	if err != nil {
		return &ProviderError{Retryable: !mutation, Unknown: mutation, cause: err}
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return &ProviderError{Retryable: !mutation, Unknown: mutation, cause: err}
	}
	if len(payload) > maxResponseBytes {
		return &ProviderError{cause: errors.New("provider response exceeds limit")}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var detail problem
		_ = json.Unmarshal(payload, &detail)
		return &ProviderError{StatusCode: response.StatusCode, Code: detail.Code, Retryable: detail.Retryable, Unknown: mutation && response.StatusCode >= 500}
	}
	if target != nil && len(payload) > 0 {
		if err := json.Unmarshal(payload, target); err != nil {
			return &ProviderError{cause: err}
		}
	}
	return nil
}
func (c *Client) doRaw(ctx context.Context, method, path, scope string) (*http.Response, error) {
	request, err := c.newRequest(ctx, method, path, scope, nil, "")
	if err != nil {
		return nil, err
	}
	response, err := c.httpClient.Do(request)
	if err != nil {
		return nil, &ProviderError{Retryable: true, cause: err}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, maxResponseBytes))
		_ = response.Body.Close()
		return nil, &ProviderError{StatusCode: response.StatusCode, Retryable: response.StatusCode >= 500}
	}
	return response, nil
}
func (c *Client) newRequest(ctx context.Context, method, path, scope string, body io.Reader, contentType string) (*http.Request, error) {
	token, err := c.tokenSource()
	if err != nil || strings.TrimSpace(token) == "" {
		return nil, &ProviderError{cause: errors.New("provider credential unavailable")}
	}
	endpoint := c.baseURL.ResolveReference(&url.URL{Path: strings.SplitN(path, "?", 2)[0]})
	if index := strings.IndexByte(path, '?'); index >= 0 {
		endpoint.RawQuery = path[index+1:]
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint.String(), body)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+strings.TrimSpace(token))
	request.Header.Set("Accept", "application/json")
	if scope != "" {
		request.Header.Set("X-Aegis-Scope", scope)
	}
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	return request, nil
}
func escapeQuotes(value string) string {
	return strings.NewReplacer("\\", "_", "\"", "_", "\r", "_", "\n", "_").Replace(value)
}
