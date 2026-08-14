package httpserver

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/1024XEngineer/aegis-sre/internal/platform/config"
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
