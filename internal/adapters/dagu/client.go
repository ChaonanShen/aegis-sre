package dagu

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

const defaultMaxResponseBytes int64 = 4 << 20

type TokenSource func() (string, error)
type BasicAuthSource func() (username string, password string, err error)

type Client struct {
	baseURL          *url.URL
	httpClient       *http.Client
	tokenSource      TokenSource
	basicAuthSource  BasicAuthSource
	maxResponseBytes int64
}

type Option func(*Client)

func WithTokenSource(source TokenSource) Option {
	return func(client *Client) { client.tokenSource = source }
}

func WithBasicAuthSource(source BasicAuthSource) Option {
	return func(client *Client) { client.basicAuthSource = source }
}

func WithMaxResponseBytes(limit int64) Option {
	return func(client *Client) { client.maxResponseBytes = limit }
}

type HTTPError struct {
	StatusCode int
	Retryable  bool
}

func (err *HTTPError) Error() string   { return fmt.Sprintf("Dagu API returned HTTP %d", err.StatusCode) }
func (err *HTTPError) HTTPStatus() int { return err.StatusCode }
func (err *HTTPError) CanRetry() bool  { return err.Retryable }

func NewClient(rawURL string, httpClient *http.Client, options ...Option) (*Client, error) {
	baseURL, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || baseURL.Scheme == "" || baseURL.Host == "" {
		return nil, errors.New("Dagu URL must be an HTTP origin")
	}
	if baseURL.Scheme != "http" && baseURL.Scheme != "https" {
		return nil, errors.New("Dagu URL must use HTTP or HTTPS")
	}
	baseURL.Path = strings.TrimRight(baseURL.Path, "/") + "/api/v1/"
	baseURL.RawQuery = ""
	baseURL.Fragment = ""
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	client := &Client{baseURL: baseURL, httpClient: httpClient, maxResponseBytes: defaultMaxResponseBytes}
	for _, option := range options {
		option(client)
	}
	if client.maxResponseBytes <= 0 {
		return nil, errors.New("Dagu response limit must be positive")
	}
	return client, nil
}

func (client *Client) ListDAGs(ctx context.Context, page, perPage int) (DAGPage, error) {
	query := url.Values{"page": {strconv.Itoa(page)}, "perPage": {strconv.Itoa(perPage)}}
	var response struct {
		DAGs       []DAGFile `json:"dags"`
		Pagination struct {
			Page       int `json:"currentPage"`
			PerPage    int `json:"perPage"`
			TotalPages int `json:"totalPages"`
		} `json:"pagination"`
	}
	if err := client.doJSON(ctx, http.MethodGet, "dags?"+query.Encode(), nil, &response); err != nil {
		return DAGPage{}, err
	}
	return DAGPage{
		DAGs: response.DAGs, Page: response.Pagination.Page,
		PerPage: response.Pagination.PerPage, TotalPages: response.Pagination.TotalPages,
	}, nil
}

func (client *Client) GetDAG(ctx context.Context, fileName string) (DAGDetails, error) {
	var response DAGDetails
	err := client.doJSON(ctx, http.MethodGet, "dags/"+url.PathEscape(fileName), nil, &response)
	return response, err
}

func (client *Client) ValidateDAG(ctx context.Context, name, spec string) (ValidationResult, error) {
	var response ValidationResult
	err := client.doJSON(ctx, http.MethodPost, "dags/validate", map[string]string{"name": name, "spec": spec}, &response)
	return response, err
}

func (client *Client) CreateDAG(ctx context.Context, name, spec string) error {
	return client.doJSON(ctx, http.MethodPost, "dags", map[string]string{"name": name, "spec": spec}, nil)
}

func (client *Client) UpdateDAG(ctx context.Context, fileName, spec string) error {
	return client.doJSON(ctx, http.MethodPut, "dags/"+url.PathEscape(fileName)+"/spec", map[string]string{"spec": spec}, nil)
}

func (client *Client) DeleteDAG(ctx context.Context, fileName string) error {
	return client.doJSON(ctx, http.MethodDelete, "dags/"+url.PathEscape(fileName), nil, nil)
}

func (client *Client) StartDAG(ctx context.Context, fileName, playbookID, runID string, params map[string]string, enqueue bool) (string, error) {
	encodedParams, err := json.Marshal(params)
	if err != nil {
		return "", fmt.Errorf("encode Dagu parameters: %w", err)
	}
	action := "start"
	if enqueue {
		action = "enqueue"
	}
	// Dagu 使用 YAML name 展示执行记录；稳定关联通过 Provider 私有标签维护。
	request := map[string]any{
		"dagRunId": runID,
		"labels":   []string{playbookRunLabel(playbookID)},
		"params":   string(encodedParams),
	}
	var response struct {
		DAGRunID string `json:"dagRunId"`
	}
	err = client.doJSON(ctx, http.MethodPost, "dags/"+url.PathEscape(fileName)+"/"+action, request, &response)
	return response.DAGRunID, err
}

func (client *Client) GetRun(ctx context.Context, name, runID string) (DAGRun, error) {
	var response struct {
		DAGRun DAGRun `json:"dagRunDetails"`
	}
	err := client.doJSON(ctx, http.MethodGet, runPath(name, runID), nil, &response)
	return response.DAGRun, err
}

func (client *Client) ListRuns(ctx context.Context, name string, limit int) ([]DAGRun, error) {
	query := url.Values{"name": {name}, "limit": {strconv.Itoa(limit)}}
	return client.listRuns(ctx, query)
}

func (client *Client) ListRunsByLabel(ctx context.Context, label string, limit int) ([]DAGRun, error) {
	query := url.Values{"labels": {label}, "limit": {strconv.Itoa(limit)}}
	return client.listRuns(ctx, query)
}

func (client *Client) listRuns(ctx context.Context, query url.Values) ([]DAGRun, error) {
	var response struct {
		Runs []DAGRun `json:"dagRuns"`
	}
	if err := client.doJSON(ctx, http.MethodGet, "dag-runs?"+query.Encode(), nil, &response); err != nil {
		return nil, err
	}
	return response.Runs, nil
}

func (client *Client) FindRun(ctx context.Context, runID string) (DAGRun, error) {
	query := url.Values{"dagRunId": {runID}, "limit": {"2"}}
	var response struct {
		Runs []DAGRun `json:"dagRuns"`
	}
	if err := client.doJSON(ctx, http.MethodGet, "dag-runs?"+query.Encode(), nil, &response); err != nil {
		return DAGRun{}, err
	}
	for _, run := range response.Runs {
		if run.DAGRunID == runID {
			return run, nil
		}
	}
	return DAGRun{}, &HTTPError{StatusCode: http.StatusNotFound}
}

func (client *Client) StopRun(ctx context.Context, name, runID string) error {
	return client.doJSON(ctx, http.MethodPost, runPath(name, runID)+"/stop", nil, nil)
}

func (client *Client) RetryRun(ctx context.Context, name, runID, newRunID string) error {
	return client.doJSON(ctx, http.MethodPost, runPath(name, runID)+"/retry", map[string]string{"dagRunId": newRunID}, nil)
}

func (client *Client) CompleteHumanTask(ctx context.Context, name, runID, stepID string, input map[string]any) error {
	path := runPath(name, runID) + "/human-tasks/" + url.PathEscape(stepID) + "/complete"
	return client.doJSON(ctx, http.MethodPost, path, input, nil)
}

func (client *Client) ResolveApproval(ctx context.Context, name, runID, stepID, decision string, input map[string]string) error {
	action := decision
	if decision == "rewind" {
		action = "push-back"
	}
	body := any(map[string]any{})
	if decision == "approve" {
		body = map[string]any{"inputs": input}
	}
	path := runPath(name, runID) + "/steps/" + url.PathEscape(stepID) + "/" + action
	return client.doJSON(ctx, http.MethodPost, path, body, nil)
}

func (client *Client) ListArtifacts(ctx context.Context, name, runID string) ([]Artifact, error) {
	var response struct {
		Items []Artifact `json:"items"`
	}
	err := client.doJSON(ctx, http.MethodGet, runPath(name, runID)+"/artifacts?recursive=true", nil, &response)
	return response.Items, err
}

func (client *Client) PreviewArtifact(ctx context.Context, name, runID, artifactPath string) (ArtifactPreview, error) {
	query := url.Values{"path": {artifactPath}}
	var response ArtifactPreview
	err := client.doJSON(ctx, http.MethodGet, runPath(name, runID)+"/artifacts/preview?"+query.Encode(), nil, &response)
	return response, err
}

func (client *Client) DownloadArtifact(ctx context.Context, name, runID, artifactPath string) ([]byte, string, error) {
	query := url.Values{"path": {artifactPath}}
	request, err := client.newRequest(ctx, http.MethodGet, runPath(name, runID)+"/artifacts/download?"+query.Encode(), nil)
	if err != nil {
		return nil, "", err
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return nil, "", fmt.Errorf("call Dagu API: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, "", statusError(response.StatusCode)
	}
	content, err := readLimited(response.Body, client.maxResponseBytes)
	if err != nil {
		return nil, "", err
	}
	return content, response.Header.Get("Content-Type"), nil
}

func runPath(name, runID string) string {
	return "dag-runs/" + url.PathEscape(name) + "/" + url.PathEscape(runID)
}

func (client *Client) doJSON(ctx context.Context, method, path string, body, output any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("encode Dagu request: %w", err)
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := client.newRequest(ctx, method, path, reader)
	if err != nil {
		return err
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return fmt.Errorf("call Dagu API: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
		return statusError(response.StatusCode)
	}
	if output == nil || response.StatusCode == http.StatusNoContent {
		return nil
	}
	content, err := readLimited(response.Body, client.maxResponseBytes)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(content, output); err != nil {
		return errors.New("decode Dagu response")
	}
	return nil
}

func (client *Client) newRequest(ctx context.Context, method, path string, body io.Reader) (*http.Request, error) {
	relative, err := url.Parse(path)
	if err != nil {
		return nil, fmt.Errorf("build Dagu path: %w", err)
	}
	endpoint := client.baseURL.ResolveReference(relative)
	request, err := http.NewRequestWithContext(ctx, method, endpoint.String(), body)
	if err != nil {
		return nil, fmt.Errorf("build Dagu request: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	if client.basicAuthSource != nil {
		username, password, err := client.basicAuthSource()
		if err != nil {
			return nil, fmt.Errorf("read Dagu basic auth: %w", err)
		}
		if strings.TrimSpace(username) == "" || strings.ContainsAny(username, "\r\n\x00") || password == "" || strings.ContainsAny(password, "\r\n\x00") {
			return nil, errors.New("read Dagu basic auth: invalid credentials")
		}
		request.SetBasicAuth(username, password)
	} else if client.tokenSource != nil {
		token, err := client.tokenSource()
		if err != nil {
			return nil, fmt.Errorf("read Dagu token: %w", err)
		}
		if strings.TrimSpace(token) == "" || strings.ContainsAny(token, "\r\n\x00") {
			return nil, errors.New("read Dagu token: invalid token")
		}
		request.Header.Set("Authorization", "Bearer "+token)
	}
	return request, nil
}

func statusError(status int) error {
	return &HTTPError{StatusCode: status, Retryable: status == http.StatusTooManyRequests || status >= 500}
}

func readLimited(reader io.Reader, limit int64) ([]byte, error) {
	content, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil {
		return nil, fmt.Errorf("read Dagu response: %w", err)
	}
	if int64(len(content)) > limit {
		return nil, errors.New("Dagu response exceeds configured limit")
	}
	return content, nil
}
