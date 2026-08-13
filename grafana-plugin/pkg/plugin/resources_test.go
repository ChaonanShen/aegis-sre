//go:build ignore

package plugin

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/1024XEngineer/Torchbearing/api/client"
	"github.com/1024XEngineer/Torchbearing/api/knowledge"
	"github.com/1024XEngineer/Torchbearing/api/resource"
	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/resource/httpadapter"
)

func TestKnowledgeBaseResourceSuccess(t *testing.T) {
	t.Parallel()

	var downstreamCalls atomic.Int32
	aiCore := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		downstreamCalls.Add(1)
		if r.Method != http.MethodGet {
			t.Errorf("downstream method = %q, want GET", r.Method)
		}
		if r.URL.Path != "/api/v1/knowledge/bases/base-1" {
			t.Errorf("downstream path = %q", r.URL.Path)
		}
		if got := r.URL.Query().Get("folder_uid"); got != "folder-1" {
			t.Errorf("folder_uid = %q, want folder-1", got)
		}
		if got := r.Header.Get("X-AI-Request-Id"); strings.TrimSpace(got) == "" {
			t.Error("X-AI-Request-Id is empty")
		}
		for _, header := range []string{
			"Authorization",
			"Cookie",
			"X-Grafana-Id",
			"X-Grafana-User",
		} {
			if got := r.Header.Get(header); got != "" {
				t.Errorf("untrusted header %s was forwarded: %q", header, got)
			}
		}

		writeTestResponse(t, w, http.StatusOK, resource.Success(
			knowledge.GetKnowledgeBaseResponse{
				KnowledgeBase: knowledge.KnowledgeBase{
					ID:        "base-1",
					Name:      "Runbooks",
					FolderUID: "folder-1",
					Version:   3,
				},
				Services: []knowledge.ServiceEntry{},
			},
		))
	}))
	t.Cleanup(aiCore.Close)

	app := newResourceTestApp(aiCore.URL)
	response := callResource(t, app, context.Background(), backend.CallResourceRequest{
		Method: http.MethodGet,
		Path:   "/api/v1/knowledge/bases/base-1",
		URL:    "/api/plugins/torchbearing-app/resources/api/v1/knowledge/bases/base-1?folder_uid=folder-1",
		Headers: map[string][]string{
			"Authorization":  {"Bearer browser-session"},
			"Cookie":         {"grafana_session=secret"},
			"X-Grafana-Id":   {"unverified-id-token"},
			"X-Grafana-User": {"alice"},
		},
	})

	if response.Status != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", response.Status, response.Body)
	}
	if got := http.Header(response.Headers).Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", got)
	}
	var envelope resource.Response
	if err := json.Unmarshal(response.Body, &envelope); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if envelope.Code != resource.CodeSuccess {
		t.Errorf("response code = %d, want 0", envelope.Code)
	}
	if downstreamCalls.Load() != 1 {
		t.Errorf("downstream calls = %d, want 1", downstreamCalls.Load())
	}
}

func TestKnowledgeBaseResourceRejectsInvalidRequestsBeforeDownstream(t *testing.T) {
	t.Parallel()

	var downstreamCalls atomic.Int32
	aiCore := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		downstreamCalls.Add(1)
	}))
	t.Cleanup(aiCore.Close)
	app := newResourceTestApp(aiCore.URL)

	tests := []struct {
		name       string
		method     string
		path       string
		rawURL     string
		wantStatus int
		wantAllow  string
	}{
		{
			name:       "wrong method",
			method:     http.MethodPost,
			path:       "/api/v1/knowledge/bases/base-1",
			rawURL:     "/api/v1/knowledge/bases/base-1?folder_uid=folder-1",
			wantStatus: http.StatusMethodNotAllowed,
			wantAllow:  http.MethodGet,
		},
		{
			name:       "missing folder uid",
			method:     http.MethodGet,
			path:       "/api/v1/knowledge/bases/base-1",
			rawURL:     "/api/v1/knowledge/bases/base-1",
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "blank folder uid",
			method:     http.MethodGet,
			path:       "/api/v1/knowledge/bases/base-1",
			rawURL:     "/api/v1/knowledge/bases/base-1?folder_uid=+++",
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "missing knowledge base id",
			method:     http.MethodGet,
			path:       "/api/v1/knowledge/bases/",
			rawURL:     "/api/v1/knowledge/bases/?folder_uid=folder-1",
			wantStatus: http.StatusNotFound,
		},
		{
			name:       "unknown route",
			method:     http.MethodGet,
			path:       "/api/v1/unknown",
			rawURL:     "/api/v1/unknown",
			wantStatus: http.StatusNotFound,
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			response := callResource(t, app, context.Background(), backend.CallResourceRequest{
				Method: tt.method,
				Path:   tt.path,
				URL:    tt.rawURL,
			})
			if response.Status != tt.wantStatus {
				t.Errorf("status = %d, want %d; body=%s", response.Status, tt.wantStatus, response.Body)
			}
			if got := http.Header(response.Headers).Get("Allow"); got != tt.wantAllow {
				t.Errorf("Allow = %q, want %q", got, tt.wantAllow)
			}
		})
	}

	if downstreamCalls.Load() != 0 {
		t.Errorf("downstream calls = %d, want 0", downstreamCalls.Load())
	}
}

func TestKnowledgeBaseResourceMapsAICoreErrors(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		apiStatus  int
		apiCode    resource.ErrorCode
		wantStatus int
	}{
		{"invalid argument", http.StatusBadRequest, resource.ErrInvalidArgument, http.StatusBadRequest},
		{"unauthenticated", http.StatusUnauthorized, resource.ErrUnauthenticated, http.StatusUnauthorized},
		{"folder denied", http.StatusForbidden, resource.ErrKnowledgeFolderDenied, http.StatusForbidden},
		{"not found", http.StatusNotFound, resource.ErrKnowledgeBaseNotFound, http.StatusNotFound},
		{"conflict", http.StatusConflict, resource.ErrConflict, http.StatusConflict},
		{"unavailable", http.StatusServiceUnavailable, resource.ErrUnavailable, http.StatusServiceUnavailable},
		{"timeout", http.StatusGatewayTimeout, resource.ErrTimeout, http.StatusGatewayTimeout},
		{"unknown business code", http.StatusInternalServerError, resource.ErrorCode(19999), http.StatusInternalServerError},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			aiCore := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				writeTestResponse(t, w, tt.apiStatus, resource.Fail(tt.apiCode, "safe message"))
			}))
			t.Cleanup(aiCore.Close)

			response := callResource(t, newResourceTestApp(aiCore.URL), context.Background(), validResourceRequest())
			if response.Status != tt.wantStatus {
				t.Errorf("status = %d, want %d; body=%s", response.Status, tt.wantStatus, response.Body)
			}
			var envelope resource.Response
			if err := json.Unmarshal(response.Body, &envelope); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if envelope.Code != int(tt.apiCode) || envelope.Message != "safe message" {
				t.Errorf("response = %#v", envelope)
			}
		})
	}
}

func TestKnowledgeBaseResourceMapsTransportAndMalformedResponses(t *testing.T) {
	t.Parallel()

	t.Run("network error", func(t *testing.T) {
		aiCore := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
		aiCoreURL := aiCore.URL
		aiCore.Close()

		response := callResource(t, newResourceTestApp(aiCoreURL), context.Background(), validResourceRequest())
		assertResourceError(t, response, http.StatusBadGateway, resource.ErrUnavailable, "AI Core unavailable")
	})

	t.Run("malformed success response", func(t *testing.T) {
		aiCore := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("{"))
		}))
		t.Cleanup(aiCore.Close)

		response := callResource(t, newResourceTestApp(aiCore.URL), context.Background(), validResourceRequest())
		assertResourceError(t, response, http.StatusBadGateway, resource.ErrUnavailable, "AI Core unavailable")
	})
}

func TestKnowledgeBaseResourcePropagatesCancellation(t *testing.T) {
	t.Parallel()

	started := make(chan struct{})
	canceled := make(chan struct{})
	aiCore := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
		close(canceled)
	}))
	t.Cleanup(aiCore.Close)

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan resourceCallResult, 1)
	app := newResourceTestApp(aiCore.URL)
	go func() {
		sender := &resourceResponseSender{}
		err := app.CallResource(ctx, resourceRequestPtr(validResourceRequest()), sender)
		done <- resourceCallResult{responses: sender.responses, err: err}
	}()

	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("AI Core request did not start")
	}
	cancel()
	var result resourceCallResult
	select {
	case result = <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("Plugin Backend call did not stop after cancellation")
	}
	select {
	case <-canceled:
	case <-time.After(3 * time.Second):
		t.Fatal("AI Core request context was not canceled")
	}
	if result.err != nil {
		t.Fatalf("CallResource: %v", result.err)
	}
	if len(result.responses) != 1 {
		t.Fatalf("response count = %d, want 1", len(result.responses))
	}
	response := result.responses[0]
	if response.Status != http.StatusOK || len(response.Body) != 0 {
		t.Errorf("canceled response = status %d body %q, want empty adapter response", response.Status, response.Body)
	}
}

func newResourceTestApp(aiCoreURL string) *App {
	app := &App{
		aiCore:    client.New(aiCoreURL, ""),
		aiModelID: "model-1",
	}
	mux := http.NewServeMux()
	app.registerRoutes(mux)
	app.CallResourceHandler = httpadapter.New(mux)
	return app
}

func validResourceRequest() backend.CallResourceRequest {
	return backend.CallResourceRequest{
		Method: http.MethodGet,
		Path:   "/api/v1/knowledge/bases/base-1",
		URL:    "/api/v1/knowledge/bases/base-1?folder_uid=folder-1",
	}
}

func callResource(
	t *testing.T,
	app *App,
	ctx context.Context,
	request backend.CallResourceRequest,
) *backend.CallResourceResponse {
	t.Helper()
	sender := &resourceResponseSender{}
	if err := app.CallResource(ctx, &request, sender); err != nil {
		t.Fatalf("CallResource: %v", err)
	}
	if len(sender.responses) != 1 {
		t.Fatalf("response count = %d, want 1", len(sender.responses))
	}
	return sender.responses[0]
}

type resourceResponseSender struct {
	responses []*backend.CallResourceResponse
}

type resourceCallResult struct {
	responses []*backend.CallResourceResponse
	err       error
}

func (s *resourceResponseSender) Send(response *backend.CallResourceResponse) error {
	s.responses = append(s.responses, response)
	return nil
}

func resourceRequestPtr(request backend.CallResourceRequest) *backend.CallResourceRequest {
	return &request
}

func writeTestResponse(t *testing.T, w http.ResponseWriter, status int, response resource.Response) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(response); err != nil {
		t.Errorf("encode response: %v", err)
	}
}

func assertResourceError(
	t *testing.T,
	response *backend.CallResourceResponse,
	wantStatus int,
	wantCode resource.ErrorCode,
	wantMessage string,
) {
	t.Helper()
	if response.Status != wantStatus {
		t.Errorf("status = %d, want %d", response.Status, wantStatus)
	}
	var envelope resource.Response
	if err := json.Unmarshal(response.Body, &envelope); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if envelope.Code != int(wantCode) || envelope.Message != wantMessage {
		t.Errorf("response = %#v", envelope)
	}
}
