package httpserver

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/1024XEngineer/aegis-sre/internal/platform/config"
)

const (
	headerRequestID = "X-Request-ID"
	headerTraceID   = "X-Trace-ID"
)

type healthResponse struct {
	Status       string            `json:"status"`
	Capabilities map[string]string `json:"capabilities,omitempty"`
}

func New(cfg config.Config, logger *slog.Logger) *http.Server {
	if logger == nil {
		logger = slog.Default()
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health/live", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, healthResponse{Status: "live"})
	})
	mux.HandleFunc("GET /health/ready", func(w http.ResponseWriter, _ *http.Request) {
		capabilities := make(map[string]string)
		for _, capability := range []config.Capability{
			config.CapabilityDatabase,
			config.CapabilityAgent,
			config.CapabilityPlaybook,
			config.CapabilityKnowledge,
			config.CapabilityGrafanaMCP,
		} {
			status := "disabled"
			if cfg.Endpoints[capability] != "" {
				status = "configured"
			}
			capabilities[string(capability)] = status
		}
		writeJSON(w, http.StatusOK, healthResponse{Status: "ready", Capabilities: capabilities})
	})

	return &http.Server{
		Addr:              cfg.HTTPAddress,
		Handler:           requestContext(logger, mux),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
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
