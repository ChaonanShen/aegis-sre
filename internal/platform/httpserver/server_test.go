package httpserver

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/1024XEngineer/aegis-sre/internal/platform/config"
	"github.com/1024XEngineer/aegis-sre/internal/ports/contracttest"
)

func TestHealthEndpoints(t *testing.T) {
	server := New(config.Config{Endpoints: map[config.Capability]string{}}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	tests := []struct {
		path   string
		status string
	}{
		{path: "/health/live", status: "live"},
		{path: "/health/ready", status: "ready"},
	}
	for _, test := range tests {
		t.Run(test.path, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, test.path, nil)
			response := httptest.NewRecorder()
			server.Handler.ServeHTTP(response, request)
			if response.Code != http.StatusOK {
				t.Fatalf("status = %d", response.Code)
			}
			var body healthResponse
			if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
				t.Fatalf("decode response: %v", err)
			}
			if body.Status != test.status {
				t.Fatalf("status = %q, want %q", body.Status, test.status)
			}
			if response.Header().Get(headerRequestID) == "" || response.Header().Get(headerTraceID) == "" {
				t.Fatal("request and trace IDs must be returned")
			}
		})
	}
}

func TestReadyReportsConfiguredButDisconnectedCapabilities(t *testing.T) {
	server := New(config.Config{Endpoints: map[config.Capability]string{
		config.CapabilityAgent: "http://agent.internal",
	}}, nil)
	response := httptest.NewRecorder()
	server.Handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/health/ready", nil))

	var body healthResponse
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if response.Code != http.StatusServiceUnavailable || body.Status != "not_ready" {
		t.Fatalf("status = %d, body = %+v", response.Code, body)
	}
	if body.Capabilities[string(config.CapabilityAgent)] != "degraded" {
		t.Fatalf("agent status = %q", body.Capabilities[string(config.CapabilityAgent)])
	}
	if body.Capabilities[string(config.CapabilityKnowledge)] != "unavailable" {
		t.Fatalf("knowledge status = %q", body.Capabilities[string(config.CapabilityKnowledge)])
	}
}

func TestReadyProbesConfiguredPlaybookProvider(t *testing.T) {
	cfg := config.Config{Endpoints: map[config.Capability]string{config.CapabilityPlaybook: "http://dagu.internal"}}
	server := New(cfg, nil, WithPlaybookProvider(&playbookHTTPFake{}))
	response := httptest.NewRecorder()
	server.Handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/health/ready", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var body healthResponse
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Capabilities[string(config.CapabilityPlaybook)] != "available" {
		t.Fatalf("playbook status = %q", body.Capabilities[string(config.CapabilityPlaybook)])
	}
}

func TestReadyProbesConnectedKnowledgeProvider(t *testing.T) {
	cfg := config.Config{Endpoints: map[config.Capability]string{config.CapabilityKnowledge: "http://ragflow.internal"}}
	server := New(cfg, nil, WithKnowledgeProvider(&contracttest.KnowledgeProvider{}, nil))
	response := httptest.NewRecorder()
	server.Handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/health/ready", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var body healthResponse
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body.Capabilities[string(config.CapabilityKnowledge)] != "available" {
		t.Fatalf("knowledge status = %q", body.Capabilities[string(config.CapabilityKnowledge)])
	}
}

func TestRequestIDsRejectHeaderControl(t *testing.T) {
	server := New(config.Config{Endpoints: map[config.Capability]string{}}, nil)
	request := httptest.NewRequest(http.MethodGet, "/health/live", nil)
	request.Header[headerRequestID] = []string{"unsafe\nvalue"}
	response := httptest.NewRecorder()
	server.Handler.ServeHTTP(response, request)
	if response.Header().Get(headerRequestID) == "unsafe\nvalue" {
		t.Fatal("unsafe request ID was trusted")
	}
}

func TestRequestAuditSeparatesRequestedAndAuthorizedFolderScope(t *testing.T) {
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, nil))
	handler := requestContext(logger, requireRequestAuthorization(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		markResourceFolder(request, "folder-a")
		w.WriteHeader(http.StatusNoContent)
	})))
	request := actorRequest(http.MethodGet, "/api/v1/test", "")
	request.Header.Set(headerFolderUID, "folder-a")
	request.Header.Set(headerFolderAccess, "write")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	logLine := output.String()
	for _, expected := range []string{`"status":204`, `"tenant_id":"tenant"`, `"org_id":"org"`, `"actor_user_id":"user"`, `"requested_folder_uid":"folder-a"`, `"authorized_folder_uid":"folder-a"`, `"resource_folder_uid":"folder-a"`, `"granted_access":"write"`} {
		if !strings.Contains(logLine, expected) {
			t.Fatalf("audit log %q does not contain %q", logLine, expected)
		}
	}
}

func TestRejectedRequestNeverPromotesRequestedFolderToAuthorizedScope(t *testing.T) {
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, nil))
	handler := requestContext(logger, requireRequestAuthorization(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {})))
	request := actorRequest(http.MethodGet, "/api/v1/test", "")
	request.Header.Set(headerFolderUID, "requested-only")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	logLine := output.String()
	if !strings.Contains(logLine, `"requested_folder_uid":"requested-only"`) || !strings.Contains(logLine, `"authorized_folder_uid":""`) {
		t.Fatalf("rejected audit scope = %q", logLine)
	}
}

func TestResourceAuditOnlyAcceptsProviderScopeMatchingAuthorizedFolder(t *testing.T) {
	audit := &requestAudit{authorizedFolderUID: "folder-a"}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/playbooks/pbk_test", nil)
	request = request.WithContext(context.WithValue(request.Context(), requestAuditContextKey{}, audit))
	markResourceFolder(request, "folder-b")
	if audit.resourceFolderUID != "" {
		t.Fatalf("cross-folder resource was promoted: %q", audit.resourceFolderUID)
	}
	markResourceFolder(request, "folder-a")
	if audit.resourceFolderUID != "folder-a" {
		t.Fatalf("verified resource folder = %q", audit.resourceFolderUID)
	}
}

func TestKnowledgeMCPIsOnlyExposedWhenConfigured(t *testing.T) {
	called := false
	handler := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { called = true; w.WriteHeader(http.StatusNoContent) })
	server := New(config.Config{Endpoints: map[config.Capability]string{}}, nil, WithKnowledgeMCP(handler))
	response := httptest.NewRecorder()
	server.Handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/mcp/knowledge", nil))
	if response.Code != http.StatusNoContent || !called {
		t.Fatalf("status = %d, called = %v", response.Code, called)
	}

	withoutMCP := New(config.Config{Endpoints: map[config.Capability]string{}}, nil)
	response = httptest.NewRecorder()
	withoutMCP.Handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/mcp/knowledge", nil))
	if response.Code != http.StatusNotFound {
		t.Fatalf("unconfigured status = %d", response.Code)
	}
}

func TestPlaybookMCPIsOnlyExposedWhenConfigured(t *testing.T) {
	handler := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	server := New(config.Config{Endpoints: map[config.Capability]string{}}, nil, WithPlaybookMCP(handler))
	response := httptest.NewRecorder()
	server.Handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/mcp/playbooks", nil))
	if response.Code != http.StatusNoContent {
		t.Fatalf("configured Playbook MCP status = %d", response.Code)
	}

	withoutMCP := New(config.Config{Endpoints: map[config.Capability]string{}}, nil)
	response = httptest.NewRecorder()
	withoutMCP.Handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/mcp/playbooks", nil))
	if response.Code != http.StatusNotFound {
		t.Fatalf("unconfigured Playbook MCP status = %d", response.Code)
	}
}
