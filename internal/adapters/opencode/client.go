package opencode

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strconv"
	"strings"
)

const maxResponseBytes int64 = 8 << 20

type Client struct {
	base       *url.URL
	httpClient *http.Client
	username   string
	password   func() (string, error)
}

type Session struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	Time  struct {
		Created  int64  `json:"created"`
		Updated  int64  `json:"updated"`
		Archived *int64 `json:"archived,omitempty"`
	} `json:"time"`
}

type Message struct {
	Info  json.RawMessage   `json:"info"`
	Parts []json.RawMessage `json:"parts"`
}

type ProjectedMessage struct {
	ID      string `json:"id"`
	Type    string `json:"type"`
	Text    string `json:"text,omitempty"`
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text,omitempty"`
	} `json:"content,omitempty"`
	Time struct {
		Created int64 `json:"created"`
	} `json:"time"`
}

func NewClient(rawURL string, httpClient *http.Client, username string, password func() (string, error)) (*Client, error) {
	base, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || base.Host == "" || (base.Scheme != "http" && base.Scheme != "https") {
		return nil, errors.New("OpenCode URL must be an HTTP origin")
	}
	base.Path = strings.TrimRight(base.Path, "/") + "/"
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	if username == "" {
		username = "opencode"
	}
	return &Client{base: base, httpClient: httpClient, username: username, password: password}, nil
}

type AdmittedInput struct {
	Sequence  int64  `json:"admittedSeq"`
	MessageID string `json:"id"`
	SessionID string `json:"sessionID"`
}

type HTTPError struct {
	Status int
}

func (err *HTTPError) Error() string   { return fmt.Sprintf("OpenCode API returned HTTP %d", err.Status) }
func (err *HTTPError) HTTPStatus() int { return err.Status }
func (err *HTTPError) CanRetry() bool {
	return err.Status == http.StatusTooManyRequests || err.Status >= 500
}

func (client *Client) Check(ctx context.Context) error {
	return client.call(ctx, http.MethodGet, "api/health", nil, nil, &struct{}{})
}

func (client *Client) CreateSession(ctx context.Context, id string) (Session, error) {
	var output struct {
		Data Session `json:"data"`
	}
	err := client.call(ctx, http.MethodPost, "api/session", nil, map[string]any{"id": id}, &output)
	return output.Data, err
}

func (client *Client) UpdateSession(ctx context.Context, id string, patch map[string]any) (Session, error) {
	var output Session
	err := client.call(ctx, http.MethodPatch, "session/"+url.PathEscape(id), nil, patch, &output)
	return output, err
}

func (client *Client) ListSessions(ctx context.Context, limit int, cursor string) ([]Session, string, error) {
	query := url.Values{"limit": {strconv.Itoa(limit)}}
	if cursor != "" {
		query.Set("cursor", cursor)
	}
	var output struct {
		Data   []Session `json:"data"`
		Cursor struct {
			Next string `json:"next"`
		} `json:"cursor"`
	}
	err := client.call(ctx, http.MethodGet, "api/session", query, nil, &output)
	return output.Data, output.Cursor.Next, err
}

func (client *Client) GetSession(ctx context.Context, id string) (Session, error) {
	var output struct {
		Data Session `json:"data"`
	}
	err := client.call(ctx, http.MethodGet, "api/session/"+url.PathEscape(id), nil, nil, &output)
	return output.Data, err
}

func (client *Client) ListMessages(ctx context.Context, sessionID, cursor string, limit int) ([]ProjectedMessage, string, error) {
	query := url.Values{"limit": {strconv.Itoa(limit)}}
	if cursor != "" {
		query.Set("cursor", cursor)
	} else {
		query.Set("order", "asc")
	}
	var output struct {
		Data   []ProjectedMessage `json:"data"`
		Cursor struct {
			Next string `json:"next"`
		} `json:"cursor"`
	}
	err := client.call(ctx, http.MethodGet, "api/session/"+url.PathEscape(sessionID)+"/message", query, nil, &output)
	return output.Data, output.Cursor.Next, err
}

func (client *Client) DeleteSession(ctx context.Context, id string) error {
	return client.call(ctx, http.MethodDelete, "session/"+url.PathEscape(id), nil, nil, nil)
}

func (client *Client) Prompt(ctx context.Context, sessionID, messageID, text string) (AdmittedInput, error) {
	body := map[string]any{"id": messageID, "prompt": map[string]string{"text": text}, "delivery": "queue", "resume": true}
	var output struct {
		Data AdmittedInput `json:"data"`
	}
	err := client.call(ctx, http.MethodPost, "api/session/"+url.PathEscape(sessionID)+"/prompt", nil, body, &output)
	return output.Data, err
}

func (client *Client) Interrupt(ctx context.Context, sessionID string) error {
	return client.call(ctx, http.MethodPost, "api/session/"+url.PathEscape(sessionID)+"/interrupt", nil, nil, nil)
}

func (client *Client) ResolvePermission(ctx context.Context, sessionID, permissionID, response string) error {
	body := map[string]any{"reply": response}
	return client.call(ctx, http.MethodPost, "api/session/"+url.PathEscape(sessionID)+"/permission/"+url.PathEscape(permissionID)+"/reply", nil, body, nil)
}

func (client *Client) SubscribeEvents(ctx context.Context, sessionID, after string) (io.ReadCloser, error) {
	query := url.Values{}
	if after != "" {
		query.Set("after", after)
	}
	request, err := client.request(ctx, http.MethodGet, "api/session/"+url.PathEscape(sessionID)+"/event", query, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "text/event-stream")
	response, err := client.httpClient.Do(request)
	if err != nil {
		return nil, fmt.Errorf("subscribe OpenCode events: %w", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		defer response.Body.Close()
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
		return nil, &HTTPError{Status: response.StatusCode}
	}
	if !strings.HasPrefix(strings.ToLower(response.Header.Get("Content-Type")), "text/event-stream") {
		response.Body.Close()
		return nil, errors.New("OpenCode event response is not text/event-stream")
	}
	return response.Body, nil
}

func (client *Client) call(ctx context.Context, method, relative string, query url.Values, body, output any) error {
	request, err := client.request(ctx, method, relative, query, body)
	if err != nil {
		return err
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return fmt.Errorf("call OpenCode API: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
		return &HTTPError{Status: response.StatusCode}
	}
	if output == nil || response.StatusCode == http.StatusNoContent {
		return nil
	}
	content, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil {
		return errors.New("read OpenCode response")
	}
	if int64(len(content)) > maxResponseBytes {
		return errors.New("OpenCode response exceeds limit")
	}
	if json.Unmarshal(content, output) != nil {
		return errors.New("decode OpenCode response")
	}
	return nil
}

func (client *Client) request(ctx context.Context, method, relative string, query url.Values, body any) (*http.Request, error) {
	endpoint := *client.base
	endpoint.RawPath = path.Join(client.base.EscapedPath(), relative)
	endpoint.Path, _ = url.PathUnescape(endpoint.RawPath)
	endpoint.RawQuery = query.Encode()
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, errors.New("encode OpenCode request")
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint.String(), reader)
	if err != nil {
		return nil, errors.New("build OpenCode request")
	}
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if client.password != nil {
		password, err := client.password()
		if err != nil {
			return nil, fmt.Errorf("read OpenCode password: %w", err)
		}
		request.SetBasicAuth(client.username, strings.TrimSpace(password))
	}
	return request, nil
}
