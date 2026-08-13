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
	ID      string `json:"id"`
	Title   string `json:"title"`
	Created int64  `json:"time_created,omitempty"`
	Updated int64  `json:"time_updated,omitempty"`
}

type Message struct {
	Info  json.RawMessage   `json:"info"`
	Parts []json.RawMessage `json:"parts"`
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

func (client *Client) CreateSession(ctx context.Context, id, title string) (Session, error) {
	var output struct {
		Data Session `json:"data"`
	}
	err := client.call(ctx, http.MethodPost, "api/session", nil, map[string]any{"id": id, "title": title}, &output)
	return output.Data, err
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

func (client *Client) DeleteSession(ctx context.Context, id string) error {
	return client.call(ctx, http.MethodDelete, "api/session/"+url.PathEscape(id), nil, nil, nil)
}

func (client *Client) PromptAsync(ctx context.Context, sessionID, messageID, text string) error {
	body := map[string]any{"messageID": messageID, "parts": []map[string]string{{"type": "text", "text": text}}}
	return client.call(ctx, http.MethodPost, "session/"+url.PathEscape(sessionID)+"/prompt_async", nil, body, nil)
}

func (client *Client) Abort(ctx context.Context, sessionID string) error {
	return client.call(ctx, http.MethodPost, "session/"+url.PathEscape(sessionID)+"/abort", nil, map[string]any{}, nil)
}

func (client *Client) ResolvePermission(ctx context.Context, sessionID, permissionID, response string) error {
	body := map[string]any{"response": response, "remember": false}
	return client.call(ctx, http.MethodPost, "session/"+url.PathEscape(sessionID)+"/permissions/"+url.PathEscape(permissionID), nil, body, nil)
}

func (client *Client) call(ctx context.Context, method, relative string, query url.Values, body, output any) error {
	endpoint := *client.base
	endpoint.RawPath = path.Join(client.base.EscapedPath(), relative)
	endpoint.Path, _ = url.PathUnescape(endpoint.RawPath)
	endpoint.RawQuery = query.Encode()
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return errors.New("encode OpenCode request")
		}
		reader = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint.String(), reader)
	if err != nil {
		return errors.New("build OpenCode request")
	}
	request.Header.Set("Accept", "application/json")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if client.password != nil {
		password, err := client.password()
		if err != nil {
			return fmt.Errorf("read OpenCode password: %w", err)
		}
		request.SetBasicAuth(client.username, strings.TrimSpace(password))
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return fmt.Errorf("call OpenCode API: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64<<10))
		return fmt.Errorf("OpenCode API returned HTTP %d", response.StatusCode)
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
