package codex

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	"github.com/1024XEngineer/aegis-sre/internal/domain"
	"github.com/1024XEngineer/aegis-sre/internal/ports"
)

const maxEarlyNotificationsPerTurn = 256

type eventHub struct {
	provider *Provider
	mu       sync.Mutex
	streams  map[string]*codexEventStream
	early    map[string][]Notification
	detached map[string]bool
	pending  map[domain.ID]pendingApproval
}

type pendingApproval struct {
	request  Request
	threadID string
	turnID   string
}

func newEventHub(provider *Provider) *eventHub {
	return &eventHub{provider: provider, streams: map[string]*codexEventStream{}, early: map[string][]Notification{}, detached: map[string]bool{}, pending: map[domain.ID]pendingApproval{}}
}

func (hub *eventHub) run() {
	for {
		select {
		case notification := <-hub.provider.transport.Notifications():
			hub.dispatch(notification)
		case request := <-hub.provider.transport.Requests():
			hub.handleRequest(request)
		case <-hub.provider.transport.Done():
			hub.stopAll()
			return
		}
	}
}

func (hub *eventHub) register(threadID, turnID string) (*codexEventStream, error) {
	select {
	case <-hub.provider.transport.Done():
		return nil, &domain.AppError{Code: domain.ErrorProviderUnavailable, Message: "Codex App Server is unavailable", Retryable: true}
	default:
	}
	stream := &codexEventStream{hub: hub, threadID: threadID, turnID: turnID, events: make(chan streamItem, maxEarlyNotificationsPerTurn+1), localDone: make(chan struct{})}
	hub.mu.Lock()
	if existing := hub.streams[turnID]; existing != nil {
		hub.mu.Unlock()
		return nil, &domain.AppError{Code: domain.ErrorConflict, Message: "Codex turn is already subscribed", Retryable: false}
	}
	queued := hub.early[turnID]
	delete(hub.early, turnID)
	delete(hub.detached, turnID)
	hub.streams[turnID] = stream
	hub.mu.Unlock()
	for _, notification := range queued {
		hub.dispatch(notification)
	}
	return stream, nil
}

func (hub *eventHub) dispatch(notification Notification) {
	threadID, turnID, ok := notificationScope(notification)
	if !ok {
		return
	}
	hub.mu.Lock()
	stream := hub.streams[turnID]
	if stream == nil {
		if !hub.detached[turnID] {
			queued := hub.early[turnID]
			if len(queued) < maxEarlyNotificationsPerTurn {
				hub.early[turnID] = append(queued, notification)
			}
		}
		hub.mu.Unlock()
		return
	}
	hub.mu.Unlock()
	if stream.threadID != threadID {
		hub.finish(turnID, stream, streamItem{err: providerResultError(errors.New("Codex notification thread does not match turn"))}, true)
		return
	}
	event, terminal, pause, err := hub.projectNotification(stream, threadID, turnID, notification)
	if err != nil {
		hub.finish(turnID, stream, streamItem{err: providerResultError(err)}, true)
		return
	}
	if event.Type == "" {
		return
	}
	if terminal || pause {
		hub.finish(turnID, stream, streamItem{event: event}, terminal)
		return
	}
	stream.emit(streamItem{event: event})
}

func (hub *eventHub) finish(turnID string, stream *codexEventStream, item streamItem, terminal bool) {
	stream.emit(item)
	hub.mu.Lock()
	if hub.streams[turnID] == stream {
		delete(hub.streams, turnID)
	}
	if terminal {
		delete(hub.early, turnID)
		delete(hub.detached, turnID)
	}
	hub.mu.Unlock()
	stream.finish()
}

func (hub *eventHub) detach(stream *codexEventStream) {
	hub.mu.Lock()
	if hub.streams[stream.turnID] == stream {
		delete(hub.streams, stream.turnID)
		hub.detached[stream.turnID] = true
	}
	hub.mu.Unlock()
}

func (hub *eventHub) stopAll() {
	hub.mu.Lock()
	streams := make([]*codexEventStream, 0, len(hub.streams))
	for _, stream := range hub.streams {
		streams = append(streams, stream)
	}
	hub.streams = map[string]*codexEventStream{}
	hub.early = map[string][]Notification{}
	hub.pending = map[domain.ID]pendingApproval{}
	hub.mu.Unlock()
	for _, stream := range streams {
		stream.emit(streamItem{err: &domain.AppError{Code: domain.ErrorProviderUnavailable, Message: "Codex App Server stopped", Retryable: true}})
		stream.finish()
	}
}

func (hub *eventHub) projectNotification(stream *codexEventStream, threadID, turnID string, notification Notification) (domain.Event, bool, bool, error) {
	switch notification.Method {
	case "item/agentMessage/delta":
		var params struct {
			Delta string `json:"delta"`
		}
		if json.Unmarshal(notification.Params, &params) != nil {
			return domain.Event{}, false, false, errors.New("invalid Codex message delta")
		}
		return stream.newEvent(domain.EventMessageDelta, map[string]any{"delta": params.Delta}, notification), false, false, nil
	case "item/started":
		payload, ok, err := hub.projectToolStarted(stream, notification)
		if err != nil || !ok {
			return domain.Event{}, false, false, err
		}
		return stream.newEvent(domain.EventToolStarted, payload, notification), false, false, nil
	case "item/completed":
		payload, ok, err := hub.projectToolCompleted(stream, notification)
		if err != nil || !ok {
			return domain.Event{}, false, false, err
		}
		return stream.newEvent(domain.EventToolCompleted, payload, notification), false, false, nil
	case "turn/completed":
		var params struct {
			Turn struct {
				Status      string `json:"status"`
				CompletedAt *int64 `json:"completedAt"`
			} `json:"turn"`
		}
		if json.Unmarshal(notification.Params, &params) != nil {
			return domain.Event{}, false, false, errors.New("invalid Codex turn completion")
		}
		if params.Turn.Status == "failed" {
			return stream.newEvent(domain.EventTurnFailed, map[string]any{"code": "agent_failed", "message": "Agent turn failed", "retryable": false}, notification), true, false, nil
		}
		status := "succeeded"
		if params.Turn.Status == "interrupted" {
			status = "interrupted"
		} else if params.Turn.Status != "completed" {
			return domain.Event{}, false, false, errors.New("invalid Codex terminal status")
		}
		return stream.newEvent(domain.EventTurnCompleted, map[string]any{"status": status}, notification), true, false, nil
	case "aegis/approval/requested":
		var params struct {
			ApprovalID domain.ID `json:"approval_id"`
			Action     string    `json:"action"`
			Reason     string    `json:"reason"`
			Risk       string    `json:"risk"`
			Preview    []string  `json:"preview"`
		}
		if json.Unmarshal(notification.Params, &params) != nil {
			return domain.Event{}, false, false, errors.New("invalid Codex approval request")
		}
		return stream.newEvent(domain.EventApprovalRequested, map[string]any{"approval_id": params.ApprovalID, "action": params.Action, "reason": params.Reason, "risk": params.Risk, "preview": params.Preview}, notification), false, true, nil
	default:
		return domain.Event{}, false, false, nil
	}
}

func (hub *eventHub) projectToolStarted(stream *codexEventStream, notification Notification) (map[string]any, bool, error) {
	var params struct {
		Item struct {
			ID        string         `json:"id"`
			Type      string         `json:"type"`
			Server    string         `json:"server"`
			Tool      string         `json:"tool"`
			Namespace *string        `json:"namespace"`
			Arguments map[string]any `json:"arguments"`
			Command   string         `json:"command"`
			Changes   []any          `json:"changes"`
		} `json:"item"`
	}
	if json.Unmarshal(notification.Params, &params) != nil || params.Item.ID == "" {
		return nil, false, errors.New("invalid Codex tool start")
	}
	server, tool, access, arguments := params.Item.Server, params.Item.Tool, "execute", params.Item.Arguments
	switch params.Item.Type {
	case "mcpToolCall":
		if server == "" || tool == "" {
			return nil, false, errors.New("invalid Codex MCP tool start")
		}
		access = codexToolAccess(tool)
	case "dynamicToolCall":
		server = "agent"
		if params.Item.Namespace != nil && *params.Item.Namespace != "" {
			server = *params.Item.Namespace
		}
		if tool == "" {
			return nil, false, errors.New("invalid Codex dynamic tool start")
		}
		access = codexToolAccess(tool)
	case "commandExecution":
		server, tool, arguments = "shell", "execute", map[string]any{"command": params.Item.Command}
	case "fileChange":
		server, tool, access, arguments = "workspace", "apply_patch", "write", map[string]any{"change_count": len(params.Item.Changes)}
	default:
		return nil, false, nil
	}
	if arguments == nil {
		arguments = map[string]any{}
	}
	callID, err := hub.provider.codec.EncodeCallKey(stream.threadID + "\x00" + stream.turnID + "\x00" + params.Item.ID)
	if err != nil {
		return nil, false, err
	}
	return map[string]any{"call_id": callID, "server": server, "tool": tool, "arguments": arguments, "access": access}, true, nil
}

func (hub *eventHub) projectToolCompleted(stream *codexEventStream, notification Notification) (map[string]any, bool, error) {
	var params struct {
		Item struct {
			ID         string `json:"id"`
			Type       string `json:"type"`
			Status     string `json:"status"`
			DurationMS *int64 `json:"durationMs"`
		} `json:"item"`
	}
	if json.Unmarshal(notification.Params, &params) != nil || params.Item.ID == "" {
		return nil, false, errors.New("invalid Codex tool completion")
	}
	switch params.Item.Type {
	case "mcpToolCall", "dynamicToolCall", "commandExecution", "fileChange":
	default:
		return nil, false, nil
	}
	status := "succeeded"
	if params.Item.Status != "completed" {
		status = "failed"
	}
	var duration any
	if params.Item.DurationMS != nil {
		duration = *params.Item.DurationMS
	}
	callID, err := hub.provider.codec.EncodeCallKey(stream.threadID + "\x00" + stream.turnID + "\x00" + params.Item.ID)
	if err != nil {
		return nil, false, err
	}
	return map[string]any{"call_id": callID, "status": status, "duration_ms": duration}, true, nil
}

func codexToolAccess(tool string) string {
	lower := strings.ToLower(tool)
	for _, marker := range []string{"get", "list", "read", "query", "search", "find"} {
		if strings.Contains(lower, marker) {
			return "read"
		}
	}
	return "execute"
}

func (hub *eventHub) handleRequest(request Request) {
	if request.Method != "item/commandExecution/requestApproval" && request.Method != "item/fileChange/requestApproval" {
		_ = hub.provider.transport.ReplyError(request, -32601, "request is not supported by Aegis")
		return
	}
	var params struct {
		ThreadID string   `json:"threadId"`
		TurnID   string   `json:"turnId"`
		ItemID   string   `json:"itemId"`
		Command  *string  `json:"command"`
		Reason   *string  `json:"reason"`
		Changes  []string `json:"changes"`
	}
	if json.Unmarshal(request.Params, &params) != nil || params.ThreadID == "" || params.TurnID == "" || params.ItemID == "" {
		_ = hub.provider.transport.ReplyError(request, -32602, "approval request is invalid")
		return
	}
	approvalID, err := hub.provider.codec.EncodeApprovalKey(string(request.ID) + "\x00" + request.Method + "\x00" + params.ItemID)
	if err != nil {
		_ = hub.provider.transport.ReplyError(request, -32603, "approval request cannot be represented")
		return
	}
	action, reason, risk := "execute command", "Codex requested command execution", "high"
	preview := []string{}
	if params.Command != nil {
		preview = append(preview, *params.Command)
	}
	if params.Reason != nil && strings.TrimSpace(*params.Reason) != "" {
		reason = *params.Reason
	}
	if request.Method == "item/fileChange/requestApproval" {
		action, reason = "apply file changes", "Codex requested file changes"
	}
	hub.mu.Lock()
	hub.pending[approvalID] = pendingApproval{request: request, threadID: params.ThreadID, turnID: params.TurnID}
	hub.mu.Unlock()
	payload, _ := json.Marshal(map[string]any{"threadId": params.ThreadID, "turnId": params.TurnID, "approval_id": approvalID, "action": action, "reason": reason, "risk": risk, "preview": preview})
	hub.dispatch(Notification{Method: "aegis/approval/requested", Params: payload})
}

func (hub *eventHub) resolveApproval(threadID string, decision ports.ApprovalDecision) (ports.EventStream, error) {
	hub.mu.Lock()
	pending, ok := hub.pending[decision.ApprovalID]
	if ok && pending.threadID == threadID {
		delete(hub.pending, decision.ApprovalID)
	}
	hub.mu.Unlock()
	if !ok || pending.threadID != threadID {
		return nil, &domain.AppError{Code: domain.ErrorNotFound, Message: "agent approval not found", Retryable: false}
	}
	stream, err := hub.register(pending.threadID, pending.turnID)
	if err != nil {
		return nil, err
	}
	providerDecision := "decline"
	if decision.Decision == ports.ApprovalApproved {
		providerDecision = "accept"
	}
	payload, _ := json.Marshal(map[string]any{"approval_id": decision.ApprovalID, "decision": decision.Decision, "reason": decision.Reason})
	stream.emit(streamItem{event: stream.newEvent(domain.EventApprovalResolved, json.RawMessage(payload), Notification{Method: "aegis/approval/resolved", Params: payload})})
	if err := hub.provider.transport.Reply(pending.request, map[string]any{"decision": providerDecision}); err != nil {
		hub.detach(stream)
		stream.finish()
		return nil, providerMutationError(err)
	}
	return stream, nil
}

func notificationScope(notification Notification) (string, string, bool) {
	var scope struct {
		ThreadID string `json:"threadId"`
		TurnID   string `json:"turnId"`
		Turn     struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	if json.Unmarshal(notification.Params, &scope) != nil || scope.ThreadID == "" {
		return "", "", false
	}
	if scope.TurnID == "" {
		scope.TurnID = scope.Turn.ID
	}
	return scope.ThreadID, scope.TurnID, scope.TurnID != ""
}

type streamItem struct {
	event domain.Event
	err   error
}

type codexEventStream struct {
	hub        *eventHub
	threadID   string
	turnID     string
	events     chan streamItem
	localDone  chan struct{}
	closeOnce  sync.Once
	finishOnce sync.Once
	sequence   int64
}

func (stream *codexEventStream) Next(ctx context.Context) (domain.Event, error) {
	select {
	case <-ctx.Done():
		return domain.Event{}, ctx.Err()
	case <-stream.localDone:
		return domain.Event{}, io.EOF
	case item, ok := <-stream.events:
		if !ok {
			return domain.Event{}, io.EOF
		}
		return item.event, item.err
	}
}

func (stream *codexEventStream) Close() error {
	stream.closeOnce.Do(func() {
		stream.hub.detach(stream)
		close(stream.localDone)
	})
	return nil
}

func (stream *codexEventStream) emit(item streamItem) {
	select {
	case stream.events <- item:
	case <-stream.localDone:
	}
}

func (stream *codexEventStream) finish() {
	stream.finishOnce.Do(func() { stream.emit(streamItem{err: io.EOF}) })
}

func (stream *codexEventStream) newEvent(eventType domain.EventType, payload any, source Notification) domain.Event {
	stream.sequence++
	content, _ := json.Marshal(payload)
	if raw, ok := payload.(json.RawMessage); ok {
		content = raw
	}
	eventID, _ := stream.hub.provider.codec.EncodeEventKey(stream.threadID + "\x00" + stream.turnID + "\x00" + source.Method + "\x00" + string(source.Params) + fmt.Sprint(stream.sequence))
	sessionID, _ := stream.hub.provider.codec.EncodeUUID(stream.threadID)
	turnID, _ := stream.hub.provider.codec.EncodeTurnUUID(stream.turnID)
	return domain.Event{ID: eventID, Type: eventType, SessionID: sessionID, TurnID: turnID, Sequence: stream.sequence, OccurredAt: time.Now().UTC(), Payload: content}
}
