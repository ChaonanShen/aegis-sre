package httpserver

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/1024XEngineer/aegis-sre/internal/domain"
	"github.com/1024XEngineer/aegis-sre/internal/ports"
)

const maxAgentJSONBytes int64 = 1 << 20

type canvasDeleter interface {
	Delete(context.Context, domain.ActorContext, domain.ID) error
}

type canvasIntegration interface {
	canvasDeleter
	Subscribe(context.Context, domain.ActorContext, domain.ID) (<-chan domain.Event, func(), error)
}

func registerAgentHandlers(mux *http.ServeMux, provider ports.AgentProvider, canvas canvasIntegration) {
	if provider == nil {
		return
	}
	mux.HandleFunc("GET /api/v1/sessions", func(w http.ResponseWriter, request *http.Request) {
		limit, ok := agentPageLimit(w, request)
		if !ok {
			return
		}
		status := domain.SessionStatus(request.URL.Query().Get("status"))
		if status == "" {
			status = domain.SessionActive
		}
		if status != domain.SessionActive && status != domain.SessionArchived {
			writeAPIProblem(w, request, http.StatusBadRequest, "invalid_argument", "invalid session status", false)
			return
		}
		page, err := provider.ListSessions(request.Context(), actorFromRequest(request), ports.ListAgentSessionsInput{
			Page: domain.PageRequest{Cursor: request.URL.Query().Get("cursor"), Limit: limit}, Status: status,
		})
		if handleProviderError(w, request, err) {
			return
		}
		items := make([]map[string]any, 0, len(page.Items))
		for _, session := range page.Items {
			items = append(items, agentSessionJSON(session))
		}
		response := map[string]any{"items": items, "has_more": page.HasMore}
		if page.NextCursor != "" {
			response["next_cursor"] = page.NextCursor
		}
		writeJSON(w, http.StatusOK, response)
	})
	mux.HandleFunc("POST /api/v1/sessions", func(w http.ResponseWriter, request *http.Request) {
		key, ok := requireIdempotencyKey(w, request)
		if !ok {
			return
		}
		var body struct {
			Title     string `json:"title"`
			FolderUID string `json:"folder_uid"`
		}
		if !decodeJSONBody(w, request, &body, maxAgentJSONBytes) {
			return
		}
		if !validAgentText(body.Title, 200) {
			writeAPIProblem(w, request, http.StatusBadRequest, "invalid_argument", "session title is required and must not exceed 200 characters", false)
			return
		}
		actor := actorFromRequest(request)
		if body.FolderUID != "" && body.FolderUID != actor.FolderUID {
			writeAPIProblem(w, request, http.StatusForbidden, "forbidden", "folder context does not match trusted actor context", false)
			return
		}
		session, err := provider.CreateSession(request.Context(), actor, ports.CreateAgentSessionInput{Title: body.Title, OperationID: key})
		if handleProviderError(w, request, err) {
			return
		}
		writeJSON(w, http.StatusCreated, agentSessionJSON(session))
	})
	mux.HandleFunc("GET /api/v1/sessions/{session_id}", func(w http.ResponseWriter, request *http.Request) {
		ref, ok := agentSessionRef(w, request)
		if !ok {
			return
		}
		detail, err := provider.ReadSession(request.Context(), actorFromRequest(request), ref)
		if handleProviderError(w, request, err) {
			return
		}
		writeJSON(w, http.StatusOK, agentSessionDetailJSON(detail))
	})
	mux.HandleFunc("PATCH /api/v1/sessions/{session_id}", func(w http.ResponseWriter, request *http.Request) {
		ref, ok := agentSessionRef(w, request)
		if !ok {
			return
		}
		var body struct {
			Title  *string               `json:"title"`
			Status *domain.SessionStatus `json:"status"`
		}
		if !decodeJSONBody(w, request, &body, maxAgentJSONBytes) {
			return
		}
		if (body.Title == nil) == (body.Status == nil) {
			writeAPIProblem(w, request, http.StatusBadRequest, "invalid_argument", "exactly one session field must be updated", false)
			return
		}
		actor := actorFromRequest(request)
		var session ports.AgentSession
		var err error
		if body.Title != nil {
			if !validAgentText(*body.Title, 200) {
				writeAPIProblem(w, request, http.StatusBadRequest, "invalid_argument", "session title is required and must not exceed 200 characters", false)
				return
			}
			session, err = provider.RenameSession(request.Context(), actor, ref, *body.Title)
		} else if *body.Status == domain.SessionArchived {
			session, err = provider.ArchiveSession(request.Context(), actor, ref)
		} else if *body.Status == domain.SessionActive {
			session, err = provider.UnarchiveSession(request.Context(), actor, ref)
		} else {
			writeAPIProblem(w, request, http.StatusBadRequest, "invalid_argument", "invalid session status", false)
			return
		}
		if handleProviderError(w, request, err) {
			return
		}
		writeJSON(w, http.StatusOK, agentSessionJSON(session))
	})
	mux.HandleFunc("DELETE /api/v1/sessions/{session_id}", func(w http.ResponseWriter, request *http.Request) {
		ref, ok := agentSessionRef(w, request)
		if !ok {
			return
		}
		providerErr := provider.DeleteSession(request.Context(), actorFromRequest(request), ref)
		if providerErr != nil && !isNotFoundError(providerErr) {
			handleProviderError(w, request, providerErr)
			return
		}
		if canvas != nil {
			if handleCanvasError(w, request, canvas.Delete(request.Context(), actorFromRequest(request), ref.ID)) {
				return
			}
		}
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("POST /api/v1/sessions/{session_id}/turns:stream", func(w http.ResponseWriter, request *http.Request) {
		ref, ok := agentSessionRef(w, request)
		if !ok {
			return
		}
		key, ok := requireIdempotencyKey(w, request)
		if !ok {
			return
		}
		var body struct {
			Message  string   `json:"message"`
			Mentions []string `json:"mentions"`
		}
		if !decodeJSONBody(w, request, &body, maxAgentJSONBytes) {
			return
		}
		if !validAgentText(body.Message, 100000) {
			writeAPIProblem(w, request, http.StatusBadRequest, "invalid_argument", "message is required and must not exceed 100000 characters", false)
			return
		}
		if len(body.Mentions) > 50 {
			writeAPIProblem(w, request, http.StatusBadRequest, "invalid_argument", "mentions must not contain more than 50 items", false)
			return
		}
		actor := actorFromRequest(request)
		turn, stream, err := provider.StartTurn(request.Context(), actor, ref, ports.StartTurnInput{
			Message: body.Message, Mentions: body.Mentions, OperationID: key, FolderUID: actor.FolderUID, CanvasContext: canvasTurnContext(canvas, ref.ID),
		})
		if handleProviderError(w, request, err) {
			return
		}
		if !validAgentID(turn.ID, "turn_") {
			_ = stream.Close()
			writeAPIProblem(w, request, http.StatusBadGateway, "provider_result_unknown", "agent provider returned an invalid turn identifier", false)
			return
		}
		started := domain.Event{ID: stableAgentEventID(ref.ID, turn.ID, key), Type: domain.EventTurnStarted, SessionID: ref.ID, TurnID: turn.ID, Sequence: 0, OccurredAt: time.Now().UTC(), Payload: json.RawMessage(`{"status":"running"}`)}
		streamSSE(w, request, &prefixedEventStream{first: started, stream: stream}, canvas)
	})
	// net/http 的路径变量必须占满整个 segment，因此把公开契约中的 :cancel 后缀一并解析。
	mux.HandleFunc("POST /api/v1/sessions/{session_id}/turns/{turn_action}", func(w http.ResponseWriter, request *http.Request) {
		session, ok := agentSessionRef(w, request)
		if !ok {
			return
		}
		turn, ok := agentTurnRef(w, request, "turn_action", ":cancel")
		if !ok || !requireIdempotencyHeader(w, request) {
			return
		}
		if handleProviderError(w, request, provider.CancelTurn(request.Context(), actorFromRequest(request), session, turn)) {
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("POST /api/v1/sessions/{session_id}/approvals/{approval_action}", func(w http.ResponseWriter, request *http.Request) {
		session, ok := agentSessionRef(w, request)
		if !ok {
			return
		}
		approvalID, found := strings.CutSuffix(request.PathValue("approval_action"), ":resolve")
		if !found {
			writeAPIProblem(w, request, http.StatusBadRequest, "invalid_argument", "invalid approval action", false)
			return
		}
		if !validAgentID(domain.ID(approvalID), "apr_") {
			writeAPIProblem(w, request, http.StatusBadRequest, "invalid_argument", "invalid approval ID", false)
			return
		}
		if !requireIdempotencyHeader(w, request) {
			return
		}
		var body struct {
			Decision ports.ApprovalDecisionValue `json:"decision"`
			Reason   string                      `json:"reason"`
		}
		if !decodeJSONBody(w, request, &body, maxAgentJSONBytes) {
			return
		}
		if (body.Decision != ports.ApprovalApproved && body.Decision != ports.ApprovalRejected) || utf8.RuneCountInString(body.Reason) > 2000 {
			writeAPIProblem(w, request, http.StatusBadRequest, "invalid_argument", "invalid approval decision", false)
			return
		}
		stream, err := provider.ResolveApproval(request.Context(), actorFromRequest(request), session, ports.ApprovalDecision{ApprovalID: domain.ID(approvalID), Decision: body.Decision, Reason: body.Reason})
		if handleProviderError(w, request, err) {
			return
		}
		streamSSE(w, request, stream)
	})
}

func canvasTurnContext(canvas canvasIntegration, sessionID domain.ID) string {
	if canvas == nil {
		return ""
	}
	return fmt.Sprintf(`[Aegis SRE Agent context] You are an observability assistant. Help the user investigate metrics through the authorized Grafana MCP, especially Prometheus data scraped from the local node-exporter. Prefer focused PromQL such as up, rate(node_cpu_seconds_total[5m]), node_memory_MemAvailable_bytes, and node_filesystem_avail_bytes when they match the request; explain assumptions and time range briefly. Current public session_id is %s. For chart requests, first use the authorized Grafana MCP query_prometheus range tool and verify it succeeds. Only after a successful query and explicit chart intent, call canvas.publish_query_chart with the exact datasource_uid, PromQL expression, absolute UTC from/to range, and step from that query. The viz_config argument MUST use this exact Canvas envelope shape: {"kind":"VizConfig","group":"timeseries","version":"v1","spec":{"options":{},"fieldConfig":{}}}. Put legend and tooltip under spec.options, and Grafana field settings under spec.fieldConfig; do not put them at the top level. Do not publish instant queries, failed queries, samples, screenshots, or provider-specific identifiers. Canvas stores the query definition and layout; the plugin re-queries Prometheus to draw the chart.`, sessionID)
}

func isNotFoundError(err error) bool {
	var appErr *domain.AppError
	return errors.As(err, &appErr) && appErr.Code == domain.ErrorNotFound
}

func agentPageLimit(w http.ResponseWriter, request *http.Request) (int, bool) {
	value := request.URL.Query().Get("limit")
	if value == "" {
		return 50, true
	}
	limit, err := strconv.Atoi(value)
	if err != nil || limit < 1 || limit > 200 {
		writeAPIProblem(w, request, http.StatusBadRequest, "invalid_argument", "limit must be between 1 and 200", false)
		return 0, false
	}
	return limit, true
}

func agentSessionRef(w http.ResponseWriter, request *http.Request) (ports.AgentSessionRef, bool) {
	id := domain.ID(request.PathValue("session_id"))
	if !validAgentID(id, "ses_") {
		writeAPIProblem(w, request, http.StatusBadRequest, "invalid_argument", "invalid session ID", false)
		return ports.AgentSessionRef{}, false
	}
	return ports.AgentSessionRef{ID: id}, true
}

func agentTurnRef(w http.ResponseWriter, request *http.Request, pathName, suffix string) (ports.AgentTurnRef, bool) {
	value, found := strings.CutSuffix(request.PathValue(pathName), suffix)
	if !found {
		writeAPIProblem(w, request, http.StatusBadRequest, "invalid_argument", "invalid turn action", false)
		return ports.AgentTurnRef{}, false
	}
	id := domain.ID(value)
	if !validAgentID(id, "turn_") {
		writeAPIProblem(w, request, http.StatusBadRequest, "invalid_argument", "invalid turn ID", false)
		return ports.AgentTurnRef{}, false
	}
	return ports.AgentTurnRef{ID: id}, true
}

func validAgentID(id domain.ID, prefix string) bool {
	return id.Valid() && strings.HasPrefix(string(id), prefix)
}

func validAgentText(value string, limit int) bool {
	return strings.TrimSpace(value) != "" && utf8.RuneCountInString(value) <= limit
}

func agentSessionJSON(session ports.AgentSession) map[string]any {
	return map[string]any{"id": session.Ref.ID, "title": session.Title, "status": session.Status, "created_at": session.CreatedAt, "updated_at": session.UpdatedAt}
}

func agentSessionDetailJSON(detail ports.AgentSessionDetail) map[string]any {
	messages := make([]map[string]any, 0, len(detail.Messages))
	for _, message := range detail.Messages {
		messages = append(messages, map[string]any{"id": message.ID, "role": message.Role, "content": message.Content, "created_at": message.CreatedAt})
	}
	return map[string]any{"session": agentSessionJSON(detail.Session), "messages": messages}
}

func stableAgentEventID(sessionID, turnID domain.ID, key string) domain.ID {
	sum := sha256.Sum256([]byte("turn.started\x00" + string(sessionID) + "\x00" + string(turnID) + "\x00" + key))
	return domain.ID("evt_" + base64.RawURLEncoding.EncodeToString(sum[:18]))
}

// prefixedEventStream 由控制面补齐公共生命周期起点，后续增量仍由 Provider 原样转换。
type prefixedEventStream struct {
	first  domain.Event
	stream ports.EventStream
	sent   bool
}

func (stream *prefixedEventStream) Next(ctx context.Context) (domain.Event, error) {
	if !stream.sent {
		stream.sent = true
		return stream.first, nil
	}
	return stream.stream.Next(ctx)
}

func (stream *prefixedEventStream) Close() error {
	if stream.stream == nil {
		return io.ErrClosedPipe
	}
	return stream.stream.Close()
}
