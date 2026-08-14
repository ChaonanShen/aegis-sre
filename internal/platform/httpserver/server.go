package httpserver

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/1024XEngineer/aegis-sre/internal/platform/config"
	"github.com/1024XEngineer/aegis-sre/internal/ports"
)

const (
	headerRequestID = "X-Request-ID"
	headerTraceID   = "X-Trace-ID"
)

type healthResponse struct {
	Status       string            `json:"status"`
	Capabilities map[string]string `json:"capabilities,omitempty"`
}

type dependencies struct {
	agents          ports.AgentProvider
	agentHealth     func(context.Context) error
	playbooks       ports.PlaybookProvider
	playbookHealth  func(context.Context) error
	knowledge       ports.KnowledgeProvider
	knowledgeIDs    ports.KnowledgeIDGenerator
	knowledgeHealth func(context.Context) error
	knowledgeMCP    http.Handler
}

func WithAgentProvider(provider ports.AgentProvider) Option {
	return func(deps *dependencies) {
		deps.agents = provider
		if provider != nil {
			deps.agentHealth = provider.Check
		}
	}
}

type Option func(*dependencies)

func WithPlaybookProvider(provider ports.PlaybookProvider) Option {
	return func(deps *dependencies) {
		deps.playbooks = provider
		if checker, ok := provider.(interface{ Check(context.Context) error }); ok {
			deps.playbookHealth = checker.Check
		}
	}
}

func WithKnowledgeProvider(provider ports.KnowledgeProvider, ids ports.KnowledgeIDGenerator) Option {
	return func(deps *dependencies) {
		deps.knowledge = provider
		deps.knowledgeIDs = ids
		if provider != nil {
			deps.knowledgeHealth = provider.Check
		}
	}
}

func WithKnowledgeMCP(handler http.Handler) Option {
	return func(deps *dependencies) { deps.knowledgeMCP = handler }
}

func New(cfg config.Config, logger *slog.Logger, options ...Option) *http.Server {
	if logger == nil {
		logger = slog.Default()
	}
	deps := dependencies{}
	for _, option := range options {
		option(&deps)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health/live", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, healthResponse{Status: "live"})
	})
	mux.HandleFunc("GET /health/ready", func(w http.ResponseWriter, request *http.Request) {
		statuses := dependencyStatuses(request.Context(), cfg, deps)
		capabilities := make(map[string]string, len(statuses))
		ready := true
		for name, status := range statuses {
			capabilities[string(name)] = status.status
			if dependencyConfigured(name, cfg, deps) && status.status != "available" {
				ready = false
			}
		}
		if !ready {
			writeJSON(w, http.StatusServiceUnavailable, healthResponse{Status: "not_ready", Capabilities: capabilities})
			return
		}
		writeJSON(w, http.StatusOK, healthResponse{Status: "ready", Capabilities: capabilities})
	})
	mux.Handle("/api/v1/", apiHandler(cfg, deps))
	if deps.knowledgeMCP != nil {
		mux.Handle("/mcp/knowledge", deps.knowledgeMCP)
	}

	return &http.Server{
		Addr:              cfg.HTTPAddress,
		Handler:           requestContext(logger, mux),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
}

func dependencyConfigured(name config.Capability, cfg config.Config, deps dependencies) bool {
	switch name {
	case config.CapabilityAgent:
		return deps.agents != nil || cfg.Endpoints[name] != ""
	case config.CapabilityPlaybook:
		return deps.playbooks != nil || cfg.Endpoints[name] != ""
	case config.CapabilityKnowledge:
		return deps.knowledge != nil || cfg.Endpoints[name] != ""
	default:
		return cfg.Endpoints[name] != ""
	}
}

func requestContext(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestID := safeID(r.Header.Get(headerRequestID))
		if requestID == "" {
			requestID = newID()
		}
		traceID := safeID(r.Header.Get(headerTraceID))
		if traceID == "" {
			traceID = requestID
		}
		w.Header().Set(headerRequestID, requestID)
		w.Header().Set(headerTraceID, traceID)
		r.Header.Set(headerRequestID, requestID)
		r.Header.Set(headerTraceID, traceID)
		started := time.Now()
		next.ServeHTTP(w, r)
		logger.Info("request completed",
			"method", r.Method,
			"path", r.URL.Path,
			"request_id", requestID,
			"trace_id", traceID,
			"duration_ms", time.Since(started).Milliseconds(),
		)
	})
}

func safeID(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 128 || strings.ContainsAny(value, "\r\n\x00") {
		return ""
	}
	return value
}

func newID() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "generated"
	}
	return hex.EncodeToString(value[:])
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
