package httpserver

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/1024XEngineer/aegis-sre/internal/adapters/canvassqlite"
	"github.com/1024XEngineer/aegis-sre/internal/application/canvas"
	"github.com/1024XEngineer/aegis-sre/internal/domain"
	"github.com/1024XEngineer/aegis-sre/internal/platform/config"
	"github.com/1024XEngineer/aegis-sre/internal/ports"
	"github.com/1024XEngineer/aegis-sre/internal/ports/contracttest"
)

func TestCanvasHTTPGetPutUsesRevisionETag(t *testing.T) {
	store, err := canvassqlite.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	agents := &contracttest.AgentProvider{SessionDetail: ports.AgentSessionDetail{Session: ports.AgentSession{Ref: ports.AgentSessionRef{ID: "ses_abcdefgh"}, Status: domain.SessionActive}}}
	handler := New(config.Config{}, nil, WithAgentProvider(agents), WithCanvasService(canvas.New(agents, store))).Handler

	get := httptest.NewRecorder()
	handler.ServeHTTP(get, actorRequest(http.MethodGet, "/api/v1/sessions/ses_abcdefgh/canvas", ""))
	if get.Code != http.StatusOK || get.Header().Get("ETag") != `"canvas:0"` {
		t.Fatalf("GET status=%d etag=%q body=%s", get.Code, get.Header().Get("ETag"), get.Body.String())
	}

	put := httptest.NewRequest(http.MethodPut, "/api/v1/sessions/ses_abcdefgh/canvas", strings.NewReader(`{"visible":true,"layout":"grid-2x2","active_chart_id":null,"ordered_chart_ids":[]}`))
	put.Header.Set("If-Match", `"canvas:0"`)
	for key, value := range map[string]string{headerTenantID: "tenant", headerOrgID: "org", headerUserID: "user"} {
		put.Header.Set(key, value)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, put)
	if response.Code != http.StatusOK || response.Header().Get("ETag") != `"canvas:1"` {
		t.Fatalf("PUT status=%d etag=%q body=%s", response.Code, response.Header().Get("ETag"), response.Body.String())
	}

	stale := httptest.NewRequest(http.MethodPut, "/api/v1/sessions/ses_abcdefgh/canvas", strings.NewReader(`{"visible":false,"layout":"flex","active_chart_id":null,"ordered_chart_ids":[]}`))
	stale.Header.Set("If-Match", `"canvas:0"`)
	for key, value := range map[string]string{headerTenantID: "tenant", headerOrgID: "org", headerUserID: "user"} {
		stale.Header.Set(key, value)
	}
	staleResponse := httptest.NewRecorder()
	handler.ServeHTTP(staleResponse, stale)
	if staleResponse.Code != http.StatusConflict {
		t.Fatalf("stale PUT status=%d body=%s", staleResponse.Code, staleResponse.Body.String())
	}
}

func TestCanvasHTTPRejectsMissingIfMatch(t *testing.T) {
	agents := &contracttest.AgentProvider{SessionDetail: ports.AgentSessionDetail{Session: ports.AgentSession{Status: domain.SessionActive}}}
	store, err := canvassqlite.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	handler := New(config.Config{}, nil, WithAgentProvider(agents), WithCanvasService(canvas.New(agents, store))).Handler
	request := actorRequest(http.MethodPut, "/api/v1/sessions/ses_abcdefgh/canvas", "")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}
