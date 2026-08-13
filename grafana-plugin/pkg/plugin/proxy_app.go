package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"time"

	pluginconfig "github.com/1024XEngineer/aegis-sre/grafana-plugin/pkg/plugin/config"
	"github.com/grafana/grafana-plugin-sdk-go/backend"
	"github.com/grafana/grafana-plugin-sdk-go/backend/instancemgmt"
	"github.com/grafana/grafana-plugin-sdk-go/backend/resource/httpadapter"
)

const (
	headerTenantID = "X-Aegis-Tenant-ID"
	headerOrgID    = "X-Aegis-Org-ID"
	headerUserID   = "X-Aegis-User-ID"
	headerUsername = "X-Aegis-Username"
	headerRoles    = "X-Aegis-Roles"
)

var errInvalidGrafanaIdentity = errors.New("invalid Grafana identity")

type App struct {
	backend.CallResourceHandler
	proxy *httputil.ReverseProxy
}

func NewApp(_ context.Context, _ backend.AppInstanceSettings) (instancemgmt.Instance, error) {
	config, err := pluginconfig.LoadControlPlaneFromEnvironment()
	if err != nil {
		return nil, err
	}
	app := newProxyApp(config)
	mux := http.NewServeMux()
	mux.Handle("/api/v1/", requireIdentity(app.proxy))
	mux.HandleFunc("/", writeNotFound)
	app.CallResourceHandler = httpadapter.New(mux)
	return app, nil
}

func newProxyApp(config pluginconfig.ControlPlane) *App {
	target := cloneURL(config.URL)
	proxy := &httputil.ReverseProxy{
		Transport: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			DialContext:           (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
			ForceAttemptHTTP2:     true,
			MaxIdleConns:          100,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   5 * time.Second,
			ResponseHeaderTimeout: 30 * time.Second,
			ExpectContinueTimeout: 1 * time.Second,
		},
		Rewrite: func(request *httputil.ProxyRequest) {
			identity, _ := trustedIdentity(request.In.Context())
			request.SetURL(target)
			request.Out.Host = target.Host
			request.Out.Header = make(http.Header)
			copyAllowedRequestHeaders(request.Out.Header, request.In.Header)
			request.Out.Header.Set(headerTenantID, identity.tenantID)
			request.Out.Header.Set(headerOrgID, identity.orgID)
			request.Out.Header.Set(headerUserID, identity.userID)
			request.Out.Header.Set(headerUsername, identity.username)
			request.Out.Header.Set(headerRoles, identity.roles)
			if config.BearerToken != "" {
				request.Out.Header.Set("Authorization", "Bearer "+config.BearerToken)
			}
		},
		ModifyResponse: func(response *http.Response) error {
			response.Header.Del("Server")
			response.Header.Del("Via")
			response.Header.Del("X-Powered-By")
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, err error) {
			backend.Logger.Error("Control Plane proxy failed", "classification", "transport_error", "error", err)
			writeProblem(w, http.StatusBadGateway, "provider_unavailable", "Control Plane unavailable")
		},
		FlushInterval: -1,
	}
	return &App{proxy: proxy}
}

func (app *App) Dispose() {}

func (app *App) CheckHealth(_ context.Context, _ *backend.CheckHealthRequest) (*backend.CheckHealthResult, error) {
	if app.proxy == nil {
		return &backend.CheckHealthResult{Status: backend.HealthStatusError, Message: "Control Plane proxy unavailable"}, nil
	}
	return &backend.CheckHealthResult{Status: backend.HealthStatusOk, Message: "Control Plane proxy configured"}, nil
}

func requireIdentity(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if _, err := trustedIdentity(request.Context()); err != nil {
			writeProblem(w, http.StatusUnauthorized, "unauthenticated", "unauthenticated")
			return
		}
		next.ServeHTTP(w, request)
	})
}

type grafanaIdentity struct {
	tenantID string
	orgID    string
	userID   string
	username string
	roles    string
}

func trustedIdentity(ctx context.Context) (grafanaIdentity, error) {
	pluginContext := backend.PluginConfigFromContext(ctx)
	tenantID := safeHeaderValue(pluginContext.Namespace)
	if tenantID == "" || pluginContext.User == nil {
		return grafanaIdentity{}, errInvalidGrafanaIdentity
	}
	login := safeHeaderValue(pluginContext.User.Login)
	if login == "" {
		return grafanaIdentity{}, errInvalidGrafanaIdentity
	}
	username := safeHeaderValue(pluginContext.User.Name)
	if username == "" {
		username = login
	}
	role := safeHeaderValue(pluginContext.User.Role)
	orgID := strconv.FormatInt(pluginContext.OrgID, 10)
	if pluginContext.OrgID <= 0 {
		orgID = tenantID
	}
	return grafanaIdentity{
		tenantID: tenantID,
		orgID:    orgID,
		userID:   fmt.Sprintf("grafana:%s:%s", tenantID, login),
		username: username,
		roles:    role,
	}, nil
}

func copyAllowedRequestHeaders(destination, source http.Header) {
	for _, name := range []string{"Accept", "Content-Type", "Idempotency-Key", "Last-Event-ID", "X-Request-ID", "X-Trace-ID"} {
		for _, value := range source.Values(name) {
			if safeHeaderValue(value) != "" {
				destination.Add(name, value)
			}
		}
	}
}

func safeHeaderValue(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 512 || strings.ContainsAny(value, "\r\n\x00") {
		return ""
	}
	return value
}

func cloneURL(source *url.URL) *url.URL {
	copy := *source
	return &copy
}

func writeNotFound(w http.ResponseWriter, _ *http.Request) {
	writeProblem(w, http.StatusNotFound, "not_found", "not found")
}

func writeProblem(w http.ResponseWriter, status int, code, detail string) {
	w.Header().Set("Content-Type", "application/problem+json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"type":       "about:blank",
		"title":      http.StatusText(status),
		"status":     status,
		"code":       code,
		"detail":     detail,
		"request_id": "plugin",
		"trace_id":   "plugin",
		"retryable":  status >= 500,
	})
}

var (
	_ backend.CallResourceHandler   = (*App)(nil)
	_ backend.CheckHealthHandler    = (*App)(nil)
	_ instancemgmt.InstanceDisposer = (*App)(nil)
)
