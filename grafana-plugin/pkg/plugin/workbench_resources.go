//go:build ignore

package plugin

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/1024XEngineer/Torchbearing/api/analysis"
	"github.com/1024XEngineer/Torchbearing/api/identity"
	"github.com/1024XEngineer/Torchbearing/api/resource"
	"github.com/1024XEngineer/Torchbearing/api/session"
	"github.com/grafana/grafana-plugin-sdk-go/backend"
)

const (
	maxWorkbenchRequestBytes   = 1 << 20
	maxWorkbenchStreamDuration = 10 * time.Minute
	workbenchStreamHeartbeat   = 15 * time.Second
)

var errInvalidPluginIdentity = errors.New("invalid Grafana plugin identity")

// pluginChatRequest 是浏览器到插件后端的窄契约。Runtime 由插件配置固定，
// 避免浏览器绕过产品策略选择任意 Agent 或模型连接。
type pluginChatRequest struct {
	ClientTurnID  string                 `json:"client_turn_id"`
	SessionID     string                 `json:"session_id"`
	Message       string                 `json:"message"`
	AnalysisScope analysis.AnalysisScope `json:"analysis_scope"`
	Context       analysis.ChatContext   `json:"context,omitempty"`
}

// handleSessions 代理会话列表与创建。浏览器请求只提供业务参数，tenant/user
// 始终由 Grafana 注入的 PluginContext 派生。
func (a *App) handleSessions(w http.ResponseWriter, r *http.Request) {
	call, err := trustedCallContext(r.Context())
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, resource.Fail(resource.ErrUnauthenticated, "unauthenticated"))
		return
	}

	switch r.Method {
	case http.MethodGet:
		filter, err := parseSessionListFilter(r)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, resource.Fail(resource.ErrInvalidArgument, "invalid request"))
			return
		}
		result, err := a.aiCore.ListSessions(r.Context(), call, filter)
		if err != nil {
			a.writeClientError(w, r, call.RequestID, err)
			return
		}
		writeJSON(w, http.StatusOK, resource.Success(result))
	case http.MethodPost:
		var request session.CreateSessionRequest
		if err := decodeWorkbenchRequest(w, r, &request); err != nil {
			writeJSON(w, http.StatusBadRequest, resource.Fail(resource.ErrInvalidArgument, "invalid request"))
			return
		}
		// Plugin Backend 尚未实现 Grafana Folder 权限校验，不能把浏览器
		// 提交的 UID 当作可信上下文再转发给 AI Core。
		if strings.TrimSpace(request.ActiveFolderUID) != "" {
			writeJSON(w, http.StatusBadRequest, resource.Fail(resource.ErrInvalidArgument, "invalid request"))
			return
		}
		result, err := a.aiCore.CreateSession(r.Context(), call, request)
		if err != nil {
			a.writeClientError(w, r, call.RequestID, err)
			return
		}
		writeJSON(w, http.StatusCreated, resource.Success(result))
	default:
		w.Header().Set("Allow", strings.Join([]string{http.MethodGet, http.MethodPost}, ", "))
		writeJSON(w, http.StatusMethodNotAllowed, resource.Fail(resource.ErrInvalidArgument, "method not allowed"))
	}
}

// handleSession 代理单个会话的读取、更新与删除。
func (a *App) handleSession(w http.ResponseWriter, r *http.Request) {
	call, err := trustedCallContext(r.Context())
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, resource.Fail(resource.ErrUnauthenticated, "unauthenticated"))
		return
	}
	sessionID := strings.TrimSpace(r.PathValue("id"))
	if sessionID == "" {
		writeJSON(w, http.StatusBadRequest, resource.Fail(resource.ErrInvalidArgument, "invalid request"))
		return
	}
	call.SessionID = sessionID

	switch r.Method {
	case http.MethodGet:
		result, err := a.aiCore.GetSession(r.Context(), call, sessionID)
		if err != nil {
			a.writeClientError(w, r, call.RequestID, err)
			return
		}
		writeJSON(w, http.StatusOK, resource.Success(result))
	case http.MethodPut:
		var request session.UpdateSessionRequest
		if err := decodeWorkbenchRequest(w, r, &request); err != nil {
			writeJSON(w, http.StatusBadRequest, resource.Fail(resource.ErrInvalidArgument, "invalid request"))
			return
		}
		// Folder UID 只能来自后续受信的 Grafana 授权链；当前浏览器入口
		// 对任何非空值 fail-closed。
		if strings.TrimSpace(request.ActiveFolderUID) != "" {
			writeJSON(w, http.StatusBadRequest, resource.Fail(resource.ErrInvalidArgument, "invalid request"))
			return
		}
		result, err := a.aiCore.UpdateSession(r.Context(), call, sessionID, request)
		if err != nil {
			a.writeClientError(w, r, call.RequestID, err)
			return
		}
		writeJSON(w, http.StatusOK, resource.Success(result))
	case http.MethodDelete:
		if err := a.aiCore.DeleteSession(r.Context(), call, sessionID); err != nil {
			a.writeClientError(w, r, call.RequestID, err)
			return
		}
		writeJSON(w, http.StatusOK, resource.Success(nil))
	default:
		w.Header().Set("Allow", strings.Join([]string{http.MethodGet, http.MethodPut, http.MethodDelete}, ", "))
		writeJSON(w, http.StatusMethodNotAllowed, resource.Fail(resource.ErrInvalidArgument, "method not allowed"))
	}
}

func (a *App) handleChat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, http.MethodPost)
		return
	}
	call, err := trustedCallContext(r.Context())
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, resource.Fail(resource.ErrUnauthenticated, "unauthenticated"))
		return
	}
	var browserRequest pluginChatRequest
	if err := decodeWorkbenchRequest(w, r, &browserRequest); err != nil {
		writeJSON(w, http.StatusBadRequest, resource.Fail(resource.ErrInvalidArgument, "invalid request"))
		return
	}
	request := analysis.ChatRequest{
		ClientTurnID:  browserRequest.ClientTurnID,
		SessionID:     browserRequest.SessionID,
		Message:       browserRequest.Message,
		AnalysisScope: browserRequest.AnalysisScope,
		Context:       browserRequest.Context,
		Runtime: analysis.AgentRunConfig{
			AgentType:       analysis.AgentTypeDeep,
			ModelID:         a.aiModelID,
			ThinkingEnabled: false,
		},
	}
	call.SessionID = request.SessionID
	streamCtx, cancel := context.WithTimeout(r.Context(), maxWorkbenchStreamDuration)
	defer cancel()
	streamRequest := r.WithContext(streamCtx)
	events, err := a.aiCore.Chat(streamCtx, call, request)
	if err != nil {
		a.writeClientError(w, streamRequest, call.RequestID, err)
		return
	}
	streamAgentEvents(w, streamRequest, call.RequestID, events)
}

func (a *App) handleChatResume(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeMethodNotAllowed(w, http.MethodPost)
		return
	}
	call, err := trustedCallContext(r.Context())
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, resource.Fail(resource.ErrUnauthenticated, "unauthenticated"))
		return
	}
	var request analysis.ResumeChatRequest
	if err := decodeWorkbenchRequest(w, r, &request); err != nil {
		writeJSON(w, http.StatusBadRequest, resource.Fail(resource.ErrInvalidArgument, "invalid request"))
		return
	}
	call.SessionID = request.SessionID
	streamCtx, cancel := context.WithTimeout(r.Context(), maxWorkbenchStreamDuration)
	defer cancel()
	streamRequest := r.WithContext(streamCtx)
	events, err := a.aiCore.ResumeChat(streamCtx, call, request)
	if err != nil {
		a.writeClientError(w, streamRequest, call.RequestID, err)
		return
	}
	streamAgentEvents(w, streamRequest, call.RequestID, events)
}

// streamAgentEvents 按公共 AgentEvent 契约重新编码 SSE，并在每个事件后 Flush。
// 这样 Grafana CallResource 能逐块交给浏览器，而不是等整轮 Agent 完成。
func streamAgentEvents(
	w http.ResponseWriter,
	r *http.Request,
	requestID string,
	events <-chan analysis.AgentEvent,
) {
	streamAgentEventsWithHeartbeat(w, r, requestID, events, workbenchStreamHeartbeat)
}

func streamAgentEventsWithHeartbeat(
	w http.ResponseWriter,
	r *http.Request,
	requestID string,
	events <-chan analysis.AgentEvent,
	heartbeatInterval time.Duration,
) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSON(w, http.StatusInternalServerError, resource.Fail(resource.ErrInternal, "streaming unavailable"))
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	heartbeat := time.NewTicker(heartbeatInterval)
	defer heartbeat.Stop()
	for {
		select {
		case event, ok := <-events:
			if !ok {
				return
			}
			if !writeAgentEvent(w, flusher, event) {
				if !errors.Is(r.Context().Err(), context.Canceled) {
					backend.Logger.Error("write AI Core SSE event failed", "requestID", requestID)
				}
				return
			}
			if terminalAgentEvent(event.Type) {
				return
			}
		case <-heartbeat.C:
			if _, err := io.WriteString(w, ": keepalive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case <-r.Context().Done():
			if errors.Is(r.Context().Err(), context.DeadlineExceeded) {
				payload, _ := analysis.MarshalError(int(resource.ErrTimeout), "agent stream timed out", true)
				_ = writeAgentEvent(w, flusher, analysis.AgentEvent{Type: analysis.EventTypeError, Payload: payload})
			}
			return
		}
	}
}

func writeAgentEvent(w http.ResponseWriter, flusher http.Flusher, event analysis.AgentEvent) bool {
	data, err := json.Marshal(event)
	if err != nil {
		return false
	}
	if _, err = fmt.Fprintf(w, "data: %s\n\n", data); err != nil {
		return false
	}
	flusher.Flush()
	return true
}

func terminalAgentEvent(eventType analysis.EventType) bool {
	switch eventType {
	case analysis.EventTypeDone, analysis.EventTypeError, analysis.EventTypeInterrupt:
		return true
	default:
		return false
	}
}

// trustedCallContext 只读取 Grafana SDK 注入的 PluginContext。浏览器即使伪造
// 同名 HTTP header，也不会改变 tenant 或 user。
func trustedCallContext(ctx context.Context) (identity.CallContext, error) {
	pluginContext := backend.PluginConfigFromContext(ctx)
	tenantID := strings.TrimSpace(pluginContext.Namespace)
	if tenantID == "" || pluginContext.User == nil || containsHeaderControl(tenantID) {
		return identity.CallContext{}, errInvalidPluginIdentity
	}
	login := strings.TrimSpace(pluginContext.User.Login)
	if login == "" || containsHeaderControl(login) {
		return identity.CallContext{}, errInvalidPluginIdentity
	}
	username := strings.TrimSpace(pluginContext.User.Name)
	if username == "" {
		username = login
	}
	if containsHeaderControl(username) {
		return identity.CallContext{}, errInvalidPluginIdentity
	}
	actor := identity.Actor{
		UserID:   fmt.Sprintf("grafana:%s:%s", tenantID, login),
		Username: username,
	}
	if role := identity.Role(strings.TrimSpace(pluginContext.User.Role)); role.Known() {
		actor.Roles = []identity.Role{role}
	}
	return identity.CallContext{
		TenantID:  identity.TenantID(tenantID),
		Actor:     actor,
		RequestID: rand.Text(),
		StartTime: time.Now().UTC(),
	}, nil
}

func containsHeaderControl(value string) bool {
	return strings.ContainsAny(value, "\r\n\x00")
}

func decodeWorkbenchRequest(w http.ResponseWriter, r *http.Request, destination any) error {
	defer r.Body.Close()
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxWorkbenchRequestBytes))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("unexpected trailing JSON")
		}
		return err
	}
	return nil
}

func parseSessionListFilter(r *http.Request) (session.ListFilter, error) {
	query := r.URL.Query()
	filter := session.ListFilter{
		Status:    session.SessionStatus(strings.TrimSpace(query.Get("status"))),
		FolderUID: strings.TrimSpace(query.Get("folder_uid")),
		Service:   strings.TrimSpace(query.Get("service")),
	}
	var err error
	if raw := strings.TrimSpace(query.Get("limit")); raw != "" {
		filter.Limit, err = strconv.Atoi(raw)
		if err != nil {
			return session.ListFilter{}, err
		}
	}
	if raw := strings.TrimSpace(query.Get("offset")); raw != "" {
		filter.Offset, err = strconv.Atoi(raw)
		if err != nil {
			return session.ListFilter{}, err
		}
	}
	if filter.Status != "" && !filter.Status.Known() {
		return session.ListFilter{}, errors.New("unknown session status")
	}
	if filter.Limit < 0 || filter.Offset < 0 {
		return session.ListFilter{}, errors.New("negative pagination")
	}
	return filter, nil
}

func writeMethodNotAllowed(w http.ResponseWriter, allowed string) {
	w.Header().Set("Allow", allowed)
	writeJSON(w, http.StatusMethodNotAllowed, resource.Fail(resource.ErrInvalidArgument, "method not allowed"))
}
