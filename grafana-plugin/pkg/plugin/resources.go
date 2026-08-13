//go:build ignore

package plugin

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/1024XEngineer/Torchbearing/api/client"
	"github.com/1024XEngineer/Torchbearing/api/identity"
	"github.com/1024XEngineer/Torchbearing/api/knowledge"
	"github.com/1024XEngineer/Torchbearing/api/resource"
	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

func (a *App) registerRoutes(mux *http.ServeMux) {
	mux.HandleFunc(resource.RouteSessions, a.handleSessions)
	mux.HandleFunc(routePattern(resource.RouteSessionByID), a.handleSession)
	mux.HandleFunc(resource.RouteChat, a.handleChat)
	mux.HandleFunc(resource.RouteChatResume, a.handleChatResume)
	knowledgeBasePattern := strings.Replace(
		resource.RouteKnowledgeBaseByID,
		":id",
		"{id}",
		1,
	)
	mux.HandleFunc(knowledgeBasePattern, a.handleKnowledgeBase)
	mux.HandleFunc("/", a.handleNotFound)
}

// routePattern 把公共契约中的路径参数转换为 net/http ServeMux 格式。
func routePattern(route string) string {
	return strings.ReplaceAll(route, ":id", "{id}")
}

func (a *App) handleKnowledgeBase(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeJSON(w, http.StatusMethodNotAllowed, resource.Fail(
			resource.ErrInvalidArgument,
			"method not allowed",
		))
		return
	}

	knowledgeBaseID := strings.TrimSpace(r.PathValue("id"))
	folderUID := strings.TrimSpace(r.URL.Query().Get("folder_uid"))
	if knowledgeBaseID == "" || folderUID == "" {
		writeJSON(w, http.StatusBadRequest, resource.Fail(
			resource.ErrInvalidArgument,
			"invalid request",
		))
		return
	}

	callContext := identity.CallContext{
		RequestID: rand.Text(),
		StartTime: time.Now(),
	}
	result, err := a.aiCore.GetKnowledgeBase(
		r.Context(),
		callContext,
		knowledge.GetKnowledgeBaseRequest{
			KnowledgeBaseID: knowledgeBaseID,
			FolderUID:       folderUID,
		},
	)
	if err != nil {
		a.writeClientError(w, r, callContext.RequestID, err)
		return
	}
	writeJSON(w, http.StatusOK, resource.Success(result))
}

func (a *App) handleNotFound(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusNotFound, resource.Fail(resource.ErrNotFound, "not found"))
}

func (a *App) writeClientError(
	w http.ResponseWriter,
	r *http.Request,
	requestID string,
	err error,
) {
	if errors.Is(r.Context().Err(), context.Canceled) {
		return
	}

	var apiErr *client.APIError
	if errors.As(err, &apiErr) {
		backend.Logger.Error(
			"AI Core request failed",
			"method", r.Method,
			"path", r.URL.Path,
			"requestID", requestID,
			"classification", "api_error",
		)
		writeJSON(w, statusForErrorCode(apiErr.Code), resource.Fail(apiErr.Code, apiErr.Message))
		return
	}

	if errors.Is(err, context.DeadlineExceeded) {
		backend.Logger.Error(
			"AI Core request failed",
			"method", r.Method,
			"path", r.URL.Path,
			"requestID", requestID,
			"classification", "timeout",
		)
		writeJSON(w, http.StatusGatewayTimeout, resource.Fail(resource.ErrTimeout, "request timeout"))
		return
	}

	backend.Logger.Error(
		"AI Core request failed",
		"method", r.Method,
		"path", r.URL.Path,
		"requestID", requestID,
		"classification", "transport_error",
	)
	writeJSON(w, http.StatusBadGateway, resource.Fail(
		resource.ErrUnavailable,
		"AI Core unavailable",
	))
}

func statusForErrorCode(code resource.ErrorCode) int {
	switch code {
	case resource.ErrInvalidArgument, resource.ErrKnowledgeLimitExceeded:
		return http.StatusBadRequest
	case resource.ErrUnauthenticated:
		return http.StatusUnauthorized
	case resource.ErrForbidden, resource.ErrKnowledgeFolderDenied:
		return http.StatusForbidden
	case resource.ErrNotFound, resource.ErrSessionNotFound, resource.ErrKnowledgeBaseNotFound:
		return http.StatusNotFound
	case resource.ErrConflict,
		resource.ErrSessionVersion,
		resource.ErrSessionArchived,
		resource.ErrSessionBusy,
		resource.ErrTurnIdempotencyConflict,
		resource.ErrKnowledgeRelationConflict:
		return http.StatusConflict
	case resource.ErrUnavailable:
		return http.StatusServiceUnavailable
	case resource.ErrTimeout:
		return http.StatusGatewayTimeout
	default:
		return http.StatusInternalServerError
	}
}

func writeJSON(w http.ResponseWriter, status int, value resource.Response) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
