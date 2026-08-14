package httpserver

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/1024XEngineer/aegis-sre/internal/platform/config"
)

const (
	headerTenantID = "X-Aegis-Tenant-ID"
	headerOrgID    = "X-Aegis-Org-ID"
	headerUserID   = "X-Aegis-User-ID"
)

type problem struct {
	Type      string `json:"type"`
	Title     string `json:"title"`
	Status    int    `json:"status"`
	Code      string `json:"code"`
	Detail    string `json:"detail,omitempty"`
	RequestID string `json:"request_id"`
	TraceID   string `json:"trace_id"`
	Retryable bool   `json:"retryable"`
}

type capability struct {
	Name   string `json:"name"`
	Status string `json:"status"`
	Reason string `json:"reason,omitempty"`
}

func apiHandler(cfg config.Config, deps dependencies) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/capabilities", func(w http.ResponseWriter, request *http.Request) {
		statuses := dependencyStatuses(request.Context(), cfg, deps)
		items := []capability{
			{Name: "agent", Status: statuses[config.CapabilityAgent].status, Reason: statuses[config.CapabilityAgent].reason},
			{Name: "knowledge", Status: statuses[config.CapabilityKnowledge].status, Reason: statuses[config.CapabilityKnowledge].reason},
			{Name: "playbook", Status: statuses[config.CapabilityPlaybook].status, Reason: statuses[config.CapabilityPlaybook].reason},
			{Name: "grafana_read", Status: statuses[config.CapabilityGrafanaMCP].status, Reason: statuses[config.CapabilityGrafanaMCP].reason},
			{Name: "grafana_write", Status: "unavailable", Reason: "not configured"},
		}
		writeJSON(w, http.StatusOK, map[string]any{"items": items})
	})
	registerPlaybookHandlers(mux, deps.playbooks)
	mux.HandleFunc("/api/v1/", func(w http.ResponseWriter, request *http.Request) {
		writeAPIProblem(w, request, http.StatusServiceUnavailable, "capability_unavailable", "capability is not configured", false)
	})
	return requireTrustedProxy(cfg.PluginToken, requireActor(mux))
}

func requireTrustedProxy(token string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if token != "" {
			provided := strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer ")
			if len(provided) != len(token) || subtle.ConstantTimeCompare([]byte(provided), []byte(token)) != 1 {
				writeAPIProblem(w, request, http.StatusUnauthorized, "unauthenticated", "untrusted proxy", false)
				return
			}
		}
		next.ServeHTTP(w, request)
	})
}

func requireActor(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		for _, name := range []string{headerTenantID, headerOrgID, headerUserID} {
			if safeID(request.Header.Get(name)) == "" {
				writeAPIProblem(w, request, http.StatusUnauthorized, "unauthenticated", "actor context is incomplete", false)
				return
			}
		}
		next.ServeHTTP(w, request)
	})
}

type dependencyStatus struct {
	status string
	reason string
}

func dependencyStatuses(ctx context.Context, cfg config.Config, deps dependencies) map[config.Capability]dependencyStatus {
	statuses := make(map[config.Capability]dependencyStatus)
	for _, name := range []config.Capability{config.CapabilityAgent, config.CapabilityPlaybook, config.CapabilityKnowledge, config.CapabilityGrafanaMCP} {
		if cfg.Endpoints[name] == "" {
			statuses[name] = dependencyStatus{status: "unavailable", reason: "not configured"}
			continue
		}
		statuses[name] = dependencyStatus{status: "degraded", reason: "adapter not connected"}
	}
	if cfg.Endpoints[config.CapabilityPlaybook] != "" && deps.playbooks != nil {
		if deps.playbookHealth == nil {
			statuses[config.CapabilityPlaybook] = dependencyStatus{status: "degraded", reason: "health probe unavailable"}
			return statuses
		}
		probeCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		if err := deps.playbookHealth(probeCtx); err != nil {
			statuses[config.CapabilityPlaybook] = dependencyStatus{status: "degraded", reason: "provider health check failed"}
		} else {
			statuses[config.CapabilityPlaybook] = dependencyStatus{status: "available"}
		}
	}
	return statuses
}

func writeAPIProblem(w http.ResponseWriter, request *http.Request, status int, code, detail string, retryable bool) {
	w.Header().Set("Content-Type", "application/problem+json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(problem{
		Type:      "about:blank",
		Title:     http.StatusText(status),
		Status:    status,
		Code:      code,
		Detail:    detail,
		RequestID: request.Header.Get(headerRequestID),
		TraceID:   request.Header.Get(headerTraceID),
		Retryable: retryable,
	})
}
