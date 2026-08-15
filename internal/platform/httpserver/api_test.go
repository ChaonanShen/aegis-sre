package httpserver

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/1024XEngineer/aegis-sre/internal/platform/config"
)

func TestCapabilitiesRequireActorAndReportUnavailable(t *testing.T) {
	handler := New(config.Config{Endpoints: map[config.Capability]string{}}, nil).Handler
	request := httptest.NewRequest(http.MethodGet, "/api/v1/capabilities", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("missing actor status = %d", response.Code)
	}

	request = httptest.NewRequest(http.MethodGet, "/api/v1/capabilities", nil)
	request.Header.Set(headerTenantID, "tenant")
	request.Header.Set(headerOrgID, "org")
	request.Header.Set(headerUserID, "user")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var body struct {
		Items []capability `json:"items"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if len(body.Items) != 6 || body.Items[0].Status != "unavailable" || body.Items[5].Name != "canvas" || body.Items[5].Status != "unavailable" {
		t.Fatalf("unexpected capabilities: %+v", body.Items)
	}
}

func TestAPIRejectsWrongProxyToken(t *testing.T) {
	handler := New(config.Config{Endpoints: map[config.Capability]string{}, PluginToken: "expected"}, nil).Handler
	request := httptest.NewRequest(http.MethodGet, "/api/v1/capabilities", nil)
	request.Header.Set("Authorization", "Bearer wrong")
	request.Header.Set(headerTenantID, "tenant")
	request.Header.Set(headerOrgID, "org")
	request.Header.Set(headerUserID, "user")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d", response.Code)
	}
}

func TestUnimplementedAPIIsExplicitlyUnavailable(t *testing.T) {
	handler := New(config.Config{Endpoints: map[config.Capability]string{}}, nil).Handler
	request := httptest.NewRequest(http.MethodGet, "/api/v1/sessions", nil)
	request.Header.Set(headerTenantID, "tenant")
	request.Header.Set(headerOrgID, "org")
	request.Header.Set(headerUserID, "user")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable || response.Header().Get("Content-Type") != "application/problem+json" {
		t.Fatalf("status = %d, content-type = %q", response.Code, response.Header().Get("Content-Type"))
	}
}
