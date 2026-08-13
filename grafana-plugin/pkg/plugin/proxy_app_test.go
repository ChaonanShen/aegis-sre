package plugin

import (
	"bufio"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	pluginconfig "github.com/1024XEngineer/aegis-sre/grafana-plugin/pkg/plugin/config"
	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

func TestProxyInjectsTrustedGrafanaIdentity(t *testing.T) {
	var received http.Header
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		received = request.Header.Clone()
		if request.URL.Path != "/api/v1/capabilities" || request.URL.RawQuery != "scope=current" {
			t.Errorf("unexpected upstream URL %s", request.URL.String())
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"items":[]}`)
	}))
	defer upstream.Close()

	app := testProxyApp(t, upstream.URL, "service-token")
	request := httptest.NewRequest(http.MethodGet, "/api/v1/capabilities?scope=current", nil)
	request.Header.Set(headerTenantID, "spoofed-tenant")
	request.Header.Set(headerUserID, "spoofed-user")
	request.Header.Set("Cookie", "must-not-forward")
	request = request.WithContext(backend.WithPluginContext(request.Context(), backend.PluginContext{
		Namespace: "tenant-1",
		OrgID:     42,
		User:      &backend.User{Login: "alice", Name: "Alice", Role: "Editor"},
	}))
	response := httptest.NewRecorder()
	requireIdentity(app.proxy).ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	for name, expected := range map[string]string{
		headerTenantID:  "tenant-1",
		headerOrgID:     "42",
		headerUserID:    "grafana:tenant-1:alice",
		headerUsername:  "Alice",
		headerRoles:     "Editor",
		"Authorization": "Bearer service-token",
	} {
		if received.Get(name) != expected {
			t.Errorf("%s = %q, want %q", name, received.Get(name), expected)
		}
	}
	if received.Get("Cookie") != "" {
		t.Fatal("browser cookies must not be forwarded")
	}
}

func TestProxyRejectsMissingOrUnsafeIdentity(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { calls.Add(1) }))
	defer upstream.Close()
	app := testProxyApp(t, upstream.URL, "")

	for name, pluginContext := range map[string]backend.PluginContext{
		"missing user":   {Namespace: "tenant"},
		"header control": {Namespace: "tenant", User: &backend.User{Login: "bad\nlogin"}},
	} {
		t.Run(name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/api/v1/capabilities", nil)
			request = request.WithContext(backend.WithPluginContext(context.Background(), pluginContext))
			response := httptest.NewRecorder()
			requireIdentity(app.proxy).ServeHTTP(response, request)
			if response.Code != http.StatusUnauthorized || !strings.Contains(response.Body.String(), "unauthenticated") {
				t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
			}
		})
	}
	if calls.Load() != 0 {
		t.Fatalf("unauthenticated requests reached upstream %d times", calls.Load())
	}
}

func TestProxyStreamsSSEWithoutChangingBody(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		flusher := w.(http.Flusher)
		_, _ = io.WriteString(w, "id: 7\ndata: first\n\n")
		flusher.Flush()
		_, _ = io.WriteString(w, "id: 8\ndata: second\n\n")
	}))
	defer upstream.Close()
	app := testProxyApp(t, upstream.URL, "")

	request := httptest.NewRequest(http.MethodPost, "/api/v1/sessions/ses_0123456789/turns:stream", nil)
	request = request.WithContext(backend.WithPluginContext(request.Context(), backend.PluginContext{
		Namespace: "tenant", User: &backend.User{Login: "alice"},
	}))
	response := httptest.NewRecorder()
	requireIdentity(app.proxy).ServeHTTP(response, request)

	reader := bufio.NewReader(response.Body)
	body, _ := io.ReadAll(reader)
	if response.Header().Get("Content-Type") != "text/event-stream" || string(body) != "id: 7\ndata: first\n\nid: 8\ndata: second\n\n" {
		t.Fatalf("unexpected SSE response: headers=%v body=%q", response.Header(), body)
	}
}

func testProxyApp(t *testing.T, rawURL, token string) *App {
	t.Helper()
	target, err := url.Parse(rawURL)
	if err != nil {
		t.Fatal(err)
	}
	return newProxyApp(pluginconfig.ControlPlane{URL: target, BearerToken: token})
}
