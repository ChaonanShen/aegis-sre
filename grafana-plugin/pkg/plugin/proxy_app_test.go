package plugin

import (
	"bufio"
	"context"
	"errors"
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
	request.Header.Set(headerFolderUID, "spoofed-folder")
	request.Header.Set(headerFolderAccess, "write")
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
	if received.Get(headerFolderUID) != "" {
		t.Fatal("unverified browser Folder header must not be forwarded")
	}
	if received.Get(headerFolderAccess) != "" {
		t.Fatal("unverified browser Folder access must not be forwarded")
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

func TestProxyPreservesPlaybookCRUDPayloadAndHeaders(t *testing.T) {
	t.Parallel()
	var receivedMethod, receivedBody, receivedContentType, receivedKey string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		receivedMethod = request.Method
		receivedContentType = request.Header.Get("Content-Type")
		receivedKey = request.Header.Get("Idempotency-Key")
		body, _ := io.ReadAll(request.Body)
		receivedBody = string(body)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	app := testProxyApp(t, upstream.URL, "")
	request := httptest.NewRequest(http.MethodDelete, "/api/v1/playbooks/pbk_scope_abcdefgh", strings.NewReader("name: diagnose\nsteps: []\n"))
	request.Header.Set("Content-Type", "application/yaml")
	request.Header.Set("Idempotency-Key", "playbook-operation-123")
	request = request.WithContext(backend.WithPluginContext(request.Context(), backend.PluginContext{Namespace: "tenant", OrgID: 1, User: &backend.User{Login: "alice", Role: "Editor"}}))
	response := httptest.NewRecorder()
	requireIdentity(app.proxy).ServeHTTP(response, request)
	if response.Code != http.StatusNoContent || receivedMethod != http.MethodDelete || receivedContentType != "application/yaml" || receivedKey != "playbook-operation-123" || receivedBody != "name: diagnose\nsteps: []\n" {
		t.Fatalf("status=%d method=%q content-type=%q key=%q body=%q", response.Code, receivedMethod, receivedContentType, receivedKey, receivedBody)
	}
}

func TestFolderAuthorizationInjectsOnlyVerifiedFolder(t *testing.T) {
	var received http.Header
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		received = request.Header.Clone()
		w.WriteHeader(http.StatusNoContent)
	}))
	defer upstream.Close()
	app := testProxyApp(t, upstream.URL, "")
	var checkedAction, checkedFolder string
	app.folderAccess = func(_ *http.Request, action, folder string) (bool, error) {
		checkedAction, checkedFolder = action, folder
		return true, nil
	}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/knowledge-bases", nil)
	request.Header.Set(headerFolderUID, "folder-a")
	request.Header.Set(headerGrafanaID, "signed-user-id-token")
	request = request.WithContext(backend.WithPluginContext(request.Context(), backend.PluginContext{Namespace: "tenant", OrgID: 1, User: &backend.User{Login: "alice", Role: "Viewer"}}))
	response := httptest.NewRecorder()
	requireIdentity(app.requireFolderAuthorization(app.proxy)).ServeHTTP(response, request)

	if response.Code != http.StatusNoContent || checkedAction != actionFolderResourcesRead || checkedFolder != "folder-a" {
		t.Fatalf("status=%d action=%q folder=%q body=%s", response.Code, checkedAction, checkedFolder, response.Body.String())
	}
	if received.Get(headerFolderUID) != "folder-a" || received.Get(headerFolderAccess) != "read" || received.Get(headerGrafanaID) != "" {
		t.Fatalf("upstream headers = %v", received)
	}
}

func TestFolderAuthorizationMapsRoutesToRequiredAccess(t *testing.T) {
	app := testProxyApp(t, "http://control-plane.invalid", "")
	tests := []struct {
		method string
		path   string
		action string
	}{
		{method: http.MethodPost, path: "/api/v1/knowledge:search", action: actionFolderResourcesRead},
		{method: http.MethodPost, path: "/api/v1/knowledge-bases", action: actionFolderResourcesWrite},
		{method: http.MethodDelete, path: "/api/v1/knowledge-bases/kbs_abcdefgh", action: actionFolderResourcesAdmin},
		{method: http.MethodPost, path: "/api/v1/sessions/session-1/turns:stream", action: actionFolderResourcesRead},
		{method: http.MethodPost, path: "/api/v1/runs/run-1/approvals/approval-1:resolve", action: actionFolderResourcesAdmin},
	}
	for _, test := range tests {
		t.Run(test.method+test.path, func(t *testing.T) {
			checked := ""
			app.folderAccess = func(_ *http.Request, action, _ string) (bool, error) {
				checked = action
				return false, nil
			}
			request := httptest.NewRequest(test.method, test.path, nil)
			request.Header.Set(headerFolderUID, "folder-a")
			request.Header.Set(headerGrafanaID, "signed-token")
			response := httptest.NewRecorder()
			app.requireFolderAuthorization(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("denied request reached upstream") })).ServeHTTP(response, request)
			if checked != test.action || response.Code != http.StatusForbidden {
				t.Fatalf("action=%q status=%d body=%s", checked, response.Code, response.Body.String())
			}
		})
	}
}

func TestFolderAuthorizationFailsClosed(t *testing.T) {
	app := testProxyApp(t, "http://control-plane.invalid", "")
	var calls atomic.Int32
	app.folderAccess = func(*http.Request, string, string) (bool, error) {
		calls.Add(1)
		return false, errors.New("Grafana auth unavailable")
	}
	tests := []struct {
		name   string
		folder string
		token  string
		status int
	}{
		{name: "missing folder", token: "token", status: http.StatusForbidden},
		{name: "unsafe folder", folder: "../escape", token: "token", status: http.StatusForbidden},
		{name: "missing ID token", folder: "folder-a", status: http.StatusUnauthorized},
		{name: "authorization unavailable", folder: "folder-a", token: "token", status: http.StatusServiceUnavailable},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/api/v1/knowledge-bases", nil)
			request.Header.Set(headerFolderUID, test.folder)
			request.Header.Set(headerGrafanaID, test.token)
			response := httptest.NewRecorder()
			app.requireFolderAuthorization(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("request reached upstream") })).ServeHTTP(response, request)
			if response.Code != test.status {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
	if calls.Load() != 1 {
		t.Fatalf("authorization calls = %d, want 1", calls.Load())
	}
}

func TestFolderAuthorizationRejectsUnknownRouteBeforeProxy(t *testing.T) {
	app := testProxyApp(t, "http://control-plane.invalid", "")
	var calls atomic.Int32
	app.folderAccess = func(*http.Request, string, string) (bool, error) {
		calls.Add(1)
		return true, nil
	}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/internal-unclassified", nil)
	response := httptest.NewRecorder()
	app.requireFolderAuthorization(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Fatal("unknown route reached upstream") })).ServeHTTP(response, request)
	if response.Code != http.StatusNotFound || calls.Load() != 0 {
		t.Fatalf("status=%d authorization calls=%d body=%s", response.Code, calls.Load(), response.Body.String())
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
