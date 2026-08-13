package plugin

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/1024XEngineer/Torchbearing/api/analysis"
	"github.com/1024XEngineer/Torchbearing/api/identity"
	"github.com/1024XEngineer/Torchbearing/api/resource"
	"github.com/1024XEngineer/Torchbearing/api/session"
	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

func TestSessionsResourceUsesOnlyTrustedPluginIdentity(t *testing.T) {
	t.Parallel()

	aiCore := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != resource.RouteSessions {
			t.Errorf("downstream request = %s %s", r.Method, r.URL.Path)
		}
		wantQuery := "folder_uid=folder-1&limit=20&offset=5&status=active"
		if r.URL.RawQuery != wantQuery {
			t.Errorf("downstream query = %q, want %q", r.URL.RawQuery, wantQuery)
		}
		assertTrustedHeaders(t, r.Header)
		if got := r.Header.Get("Authorization"); got != "" {
			t.Errorf("browser Authorization leaked downstream: %q", got)
		}
		writeTestResponse(t, w, http.StatusOK, resource.Success([]session.Session{{
			ID:         "session-1",
			TenantID:   identity.TenantID("stack-1"),
			UserID:     "grafana:stack-1:alice",
			Title:      "CPU",
			Status:     session.SessionStatusActive,
			Visibility: session.VisibilityPrivate,
		}}))
	}))
	t.Cleanup(aiCore.Close)

	request := trustedWorkbenchRequest(
		http.MethodGet,
		resource.RouteSessions,
		resource.RouteSessions+"?status=active&folder_uid=folder-1&limit=20&offset=5",
		nil,
	)
	request.Headers = map[string][]string{
		"Authorization": {"Bearer browser-session"},
		"Cookie":        {"grafana_session=secret"},
		"X-Tenant-Id":   {"forged-tenant"},
		"X-User-Id":     {"forged-user"},
		"X-Request-Id":  {"forged-request"},
	}
	response := callResource(t, newResourceTestApp(aiCore.URL), context.Background(), request)
	if response.Status != http.StatusOK {
		t.Fatalf("status = %d; body=%s", response.Status, response.Body)
	}
	var envelope struct {
		Code int               `json:"code"`
		Data []session.Session `json:"data"`
	}
	if err := json.Unmarshal(response.Body, &envelope); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if envelope.Code != resource.CodeSuccess || len(envelope.Data) != 1 || envelope.Data[0].ID != "session-1" {
		t.Fatalf("response = %#v", envelope)
	}
}

func TestSessionResourceProxiesCurrentCRUDContract(t *testing.T) {
	t.Parallel()

	var downstreamCalls atomic.Int32
	aiCore := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		downstreamCalls.Add(1)
		assertTrustedHeaders(t, r.Header)
		switch r.Method {
		case http.MethodPost:
			if r.URL.Path != resource.RouteSessions {
				t.Errorf("create path = %q", r.URL.Path)
			}
			var request session.CreateSessionRequest
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil || request.Title != "CPU" {
				t.Errorf("create request = %#v, error = %v", request, err)
			}
			writeTestResponse(t, w, http.StatusCreated, resource.Success(session.Session{ID: "session-1", Title: request.Title}))
		case http.MethodGet:
			if r.URL.Path != "/api/v1/sessions/session-1" {
				t.Errorf("get path = %q", r.URL.Path)
			}
			writeTestResponse(t, w, http.StatusOK, resource.Success(session.GetSessionResponse{Session: session.Session{ID: "session-1"}}))
		case http.MethodPut:
			var request session.UpdateSessionRequest
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil || request.Version != 3 || request.Title != "Memory" {
				t.Errorf("update request = %#v, error = %v", request, err)
			}
			writeTestResponse(t, w, http.StatusOK, resource.Success(session.Session{ID: "session-1", Title: request.Title, Version: 4}))
		case http.MethodDelete:
			writeTestResponse(t, w, http.StatusOK, resource.Success(nil))
		default:
			t.Errorf("unexpected method %q", r.Method)
		}
	}))
	t.Cleanup(aiCore.Close)
	app := newResourceTestApp(aiCore.URL)

	tests := []struct {
		name       string
		method     string
		path       string
		body       string
		wantStatus int
	}{
		{"create", http.MethodPost, resource.RouteSessions, `{"title":"CPU"}`, http.StatusCreated},
		{"get", http.MethodGet, "/api/v1/sessions/session-1", "", http.StatusOK},
		{"update", http.MethodPut, "/api/v1/sessions/session-1", `{"title":"Memory","status":"active","version":3}`, http.StatusOK},
		{"delete", http.MethodDelete, "/api/v1/sessions/session-1", "", http.StatusOK},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := callResource(t, app, context.Background(), trustedWorkbenchRequest(
				test.method,
				test.path,
				test.path,
				[]byte(test.body),
			))
			if response.Status != test.wantStatus {
				t.Fatalf("status = %d, want %d; body=%s", response.Status, test.wantStatus, response.Body)
			}
		})
	}
	if downstreamCalls.Load() != int32(len(tests)) {
		t.Fatalf("downstream calls = %d, want %d", downstreamCalls.Load(), len(tests))
	}
}

func TestSessionResourceRejectsBrowserFolderContextBeforeProxy(t *testing.T) {
	t.Parallel()

	var downstreamCalls atomic.Int32
	aiCore := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		downstreamCalls.Add(1)
		writeTestResponse(t, w, http.StatusOK, resource.Success(nil))
	}))
	t.Cleanup(aiCore.Close)
	app := newResourceTestApp(aiCore.URL)

	tests := []struct {
		name   string
		method string
		path   string
		body   string
	}{
		{"create", http.MethodPost, resource.RouteSessions, `{"title":"CPU","active_folder_uid":"infra"}`},
		{"update", http.MethodPut, "/api/v1/sessions/session-1", `{"title":"CPU","status":"active","active_folder_uid":"infra","version":1}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := callResource(t, app, context.Background(), trustedWorkbenchRequest(
				test.method,
				test.path,
				test.path,
				[]byte(test.body),
			))
			if response.Status != http.StatusBadRequest {
				t.Fatalf("status = %d, want %d; body=%s", response.Status, http.StatusBadRequest, response.Body)
			}
			var envelope resource.Response
			if err := json.Unmarshal(response.Body, &envelope); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if envelope.Code != int(resource.ErrInvalidArgument) {
				t.Fatalf("code = %d, want %d", envelope.Code, resource.ErrInvalidArgument)
			}
		})
	}
	if downstreamCalls.Load() != 0 {
		t.Fatalf("downstream calls = %d, want 0", downstreamCalls.Load())
	}
}

func TestChatResourceStreamsCurrentAgentEvents(t *testing.T) {
	t.Parallel()

	aiCore := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != resource.RouteChat {
			t.Errorf("downstream request = %s %s", r.Method, r.URL.Path)
		}
		assertTrustedHeaders(t, r.Header)
		if got := r.Header.Get("Accept"); got != "text/event-stream" {
			t.Errorf("Accept = %q", got)
		}
		var request analysis.ChatRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode request: %v", err)
		}
		if request.SessionID != "session-1" || request.Runtime.AgentType != analysis.AgentTypeDeep ||
			request.Runtime.ModelID != analysis.ModelID("model-1") || len(request.AnalysisScope.DatasourceUIDs) != 1 {
			t.Errorf("chat request = %#v", request)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher := w.(http.Flusher)
		_, _ = fmt.Fprint(w, "data: {\"type\":\"message\",\"payload\":{\"delta\":\"你\"}}\n\n")
		flusher.Flush()
		_, _ = fmt.Fprint(w, "data: {\"type\":\"done\",\"payload\":{\"turn_id\":\"turn-1\",\"replayed\":false}}\n\n")
		flusher.Flush()
	}))
	t.Cleanup(aiCore.Close)

	body := []byte(`{
		"client_turn_id":"018f3f4e-7b1a-7c9d-8d16-123456789abc",
		"session_id":"session-1",
		"message":"最近 30 分钟 CPU",
		"analysis_scope":{"datasource_uids":["ceph"]},
		"context":{"folder_uid":"infra"}
	}`)
	request := trustedWorkbenchRequest(http.MethodPost, resource.RouteChat, resource.RouteChat, body)
	request.Headers = map[string][]string{"X-User-Id": {"forged-user"}}
	sender := &resourceResponseSender{}
	if err := newResourceTestApp(aiCore.URL).CallResource(context.Background(), &request, sender); err != nil {
		t.Fatalf("CallResource: %v", err)
	}
	if len(sender.responses) < 3 {
		t.Fatalf("response chunks = %d, want at least 3", len(sender.responses))
	}
	if sender.responses[0].Status != http.StatusOK ||
		http.Header(sender.responses[0].Headers).Get("Content-Type") != "text/event-stream" {
		t.Fatalf("first response = %#v", sender.responses[0])
	}
	var stream strings.Builder
	for _, response := range sender.responses {
		stream.Write(response.Body)
	}
	if !strings.Contains(stream.String(), `"type":"message"`) ||
		!strings.Contains(stream.String(), `"type":"done"`) || strings.Contains(stream.String(), "[DONE]") {
		t.Fatalf("stream = %q", stream.String())
	}
}

func TestWorkbenchStreamSendsHeartbeatAndTerminalTimeout(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Millisecond)
	defer cancel()
	request := httptest.NewRequest(http.MethodPost, resource.RouteChat, nil).WithContext(ctx)
	recorder := httptest.NewRecorder()
	streamAgentEventsWithHeartbeat(
		recorder,
		request,
		"request-1",
		make(chan analysis.AgentEvent),
		time.Millisecond,
	)
	body := recorder.Body.String()
	if !strings.Contains(body, ": keepalive\n\n") || !strings.Contains(body, `"type":"error"`) || !strings.Contains(body, `"code":1008`) {
		t.Fatalf("stream body=%q", body)
	}
}

func TestChatResumeResourceUsesCurrentContract(t *testing.T) {
	t.Parallel()

	aiCore := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != resource.RouteChatResume {
			t.Errorf("path = %q", r.URL.Path)
		}
		assertTrustedHeaders(t, r.Header)
		var request analysis.ResumeChatRequest
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil ||
			request.CheckpointID != "checkpoint-1" || request.Decision != analysis.InterruptDecisionApproved {
			t.Errorf("resume request = %#v, error = %v", request, err)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: {\"type\":\"done\",\"payload\":{\"turn_id\":\"turn-1\"}}\n\n")
	}))
	t.Cleanup(aiCore.Close)

	body := []byte(`{
		"session_id":"session-1",
		"client_turn_id":"018f3f4e-7b1a-7c9d-8d16-123456789abc",
		"checkpoint_id":"checkpoint-1",
		"decision":"approved"
	}`)
	request := trustedWorkbenchRequest(http.MethodPost, resource.RouteChatResume, resource.RouteChatResume, body)
	sender := &resourceResponseSender{}
	if err := newResourceTestApp(aiCore.URL).CallResource(context.Background(), &request, sender); err != nil {
		t.Fatalf("CallResource: %v", err)
	}
	var stream strings.Builder
	for _, response := range sender.responses {
		stream.Write(response.Body)
	}
	if !strings.Contains(stream.String(), `"type":"done"`) {
		t.Fatalf("stream = %q", stream.String())
	}
}

func TestChatResourcePreservesAICoreBusinessError(t *testing.T) {
	t.Parallel()

	aiCore := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeTestResponse(t, w, http.StatusConflict, resource.Fail(resource.ErrSessionBusy, "session busy"))
	}))
	t.Cleanup(aiCore.Close)
	body := []byte(`{
		"client_turn_id":"018f3f4e-7b1a-7c9d-8d16-123456789abc",
		"session_id":"session-1","message":"CPU",
		"analysis_scope":{"datasource_uids":[]}
	}`)
	response := callResource(t, newResourceTestApp(aiCore.URL), context.Background(),
		trustedWorkbenchRequest(http.MethodPost, resource.RouteChat, resource.RouteChat, body))
	assertResourceError(t, response, http.StatusConflict, resource.ErrSessionBusy, "session busy")
}

func TestChatResourceRejectsBrowserRuntime(t *testing.T) {
	t.Parallel()

	var downstreamCalls atomic.Int32
	aiCore := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		downstreamCalls.Add(1)
	}))
	t.Cleanup(aiCore.Close)
	body := []byte(`{
		"client_turn_id":"018f3f4e-7b1a-7c9d-8d16-123456789abc",
		"session_id":"session-1","message":"CPU",
		"runtime":{"agent_type":"plan_execute","model_id":"other-model","thinking_enabled":true},
		"analysis_scope":{"datasource_uids":[]}
	}`)
	response := callResource(t, newResourceTestApp(aiCore.URL), context.Background(),
		trustedWorkbenchRequest(http.MethodPost, resource.RouteChat, resource.RouteChat, body))
	assertResourceError(t, response, http.StatusBadRequest, resource.ErrInvalidArgument, "invalid request")
	if downstreamCalls.Load() != 0 {
		t.Fatalf("downstream calls = %d, want 0", downstreamCalls.Load())
	}
}

func TestWorkbenchResourcesRejectMissingPluginIdentity(t *testing.T) {
	t.Parallel()

	var downstreamCalls atomic.Int32
	aiCore := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		downstreamCalls.Add(1)
	}))
	t.Cleanup(aiCore.Close)
	request := backend.CallResourceRequest{
		Method:  http.MethodGet,
		Path:    resource.RouteSessions,
		URL:     resource.RouteSessions,
		Headers: map[string][]string{"X-Tenant-Id": {"forged"}, "X-User-Id": {"forged"}},
	}
	response := callResource(t, newResourceTestApp(aiCore.URL), context.Background(), request)
	assertResourceError(t, response, http.StatusUnauthorized, resource.ErrUnauthenticated, "unauthenticated")
	if downstreamCalls.Load() != 0 {
		t.Fatalf("downstream calls = %d, want 0", downstreamCalls.Load())
	}
}

func trustedWorkbenchRequest(method, path, rawURL string, body []byte) backend.CallResourceRequest {
	return backend.CallResourceRequest{
		Method: method,
		Path:   path,
		URL:    rawURL,
		Body:   body,
		PluginContext: backend.PluginContext{
			Namespace: "stack-1",
			User: &backend.User{
				Login: "alice",
				Name:  "Alice",
				Role:  "Editor",
			},
		},
	}
}

func assertTrustedHeaders(t *testing.T, header http.Header) {
	t.Helper()
	want := map[string]string{
		"X-Tenant-Id": "stack-1",
		"X-User-Id":   "grafana:stack-1:alice",
	}
	for name, value := range want {
		if got := header.Get(name); got != value {
			t.Errorf("%s = %q, want %q", name, got, value)
		}
	}
	if strings.TrimSpace(header.Get("X-Request-Id")) == "" {
		t.Error("X-Request-Id is empty")
	}
}
