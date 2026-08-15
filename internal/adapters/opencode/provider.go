package opencode

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/1024XEngineer/aegis-sre/internal/adapters/agentid"
	"github.com/1024XEngineer/aegis-sre/internal/domain"
	"github.com/1024XEngineer/aegis-sre/internal/ports"
)

type Provider struct {
	client *Client
	codec  *agentid.Codec
}

func NewProvider(client *Client, codec *agentid.Codec) (*Provider, error) {
	if client == nil || codec == nil {
		return nil, errors.New("OpenCode client and agent ID codec are required")
	}
	return &Provider{client: client, codec: codec}, nil
}

func (provider *Provider) Check(ctx context.Context) error { return provider.client.Check(ctx) }

func (provider *Provider) ListSessions(ctx context.Context, _ domain.ActorContext, input ports.ListAgentSessionsInput) (domain.Page[ports.AgentSession], error) {
	sessions, next, err := provider.client.ListSessions(ctx, input.Page.Limit, input.Page.Cursor)
	if err != nil {
		return domain.Page[ports.AgentSession]{}, err
	}
	items := make([]ports.AgentSession, 0, len(sessions))
	for _, session := range sessions {
		projected := projectSession(session)
		if projected.Status == input.Status {
			items = append(items, projected)
		}
	}
	return domain.Page[ports.AgentSession]{Items: items, NextCursor: next, HasMore: next != ""}, nil
}

func (provider *Provider) CreateSession(ctx context.Context, actor domain.ActorContext, input ports.CreateAgentSessionInput) (ports.AgentSession, error) {
	id, err := provider.codec.EncodeSessionKey(actor.TenantID + "\x00" + actor.OrgID + "\x00" + actor.UserID + "\x00" + input.OperationID)
	if err != nil {
		return ports.AgentSession{}, invalidOpenCodeArgument(err)
	}
	// V2 不会把全局默认模型隐式写入会话；创建时必须显式传入 Provider 原生配置中的默认模型。
	model, err := provider.client.DefaultModel(ctx)
	if err != nil {
		return ports.AgentSession{}, err
	}
	session, err := provider.client.CreateSession(ctx, string(id), model)
	if err != nil {
		var httpErr *HTTPError
		if !errors.As(err, &httpErr) || httpErr.Status != http.StatusConflict {
			return ports.AgentSession{}, err
		}
		// V2 接受调用方 Session ID；冲突时直接读取原生会话即可实现无影子表幂等。
		session, err = provider.client.GetSession(ctx, string(id))
		if err != nil {
			return ports.AgentSession{}, err
		}
		// 兼容修复历史上未绑定模型、已经创建成功但无法执行回合的会话。
		if err := provider.client.SwitchSessionModel(ctx, string(id), model); err != nil {
			return ports.AgentSession{}, err
		}
	}
	if session.Title != input.Title {
		session, err = provider.client.UpdateSession(ctx, string(id), map[string]any{"title": input.Title})
		if err != nil {
			return ports.AgentSession{}, err
		}
	}
	return projectSession(session), nil
}

func (provider *Provider) ReadSession(ctx context.Context, _ domain.ActorContext, ref ports.AgentSessionRef) (ports.AgentSessionDetail, error) {
	if err := validateOpenCodeSessionRef(ref); err != nil {
		return ports.AgentSessionDetail{}, err
	}
	session, err := provider.client.GetSession(ctx, string(ref.ID))
	if err != nil {
		return ports.AgentSessionDetail{}, err
	}
	messages, err := provider.readAllMessages(ctx, string(ref.ID))
	if err != nil {
		return ports.AgentSessionDetail{}, err
	}
	return ports.AgentSessionDetail{Session: projectSession(session), Messages: messages}, nil
}

func (provider *Provider) RenameSession(ctx context.Context, _ domain.ActorContext, ref ports.AgentSessionRef, title string) (ports.AgentSession, error) {
	if err := validateOpenCodeSessionRef(ref); err != nil {
		return ports.AgentSession{}, err
	}
	session, err := provider.client.UpdateSession(ctx, string(ref.ID), map[string]any{"title": title})
	return projectSession(session), err
}

func (provider *Provider) ArchiveSession(ctx context.Context, _ domain.ActorContext, ref ports.AgentSessionRef) (ports.AgentSession, error) {
	if err := validateOpenCodeSessionRef(ref); err != nil {
		return ports.AgentSession{}, err
	}
	session, err := provider.client.UpdateSession(ctx, string(ref.ID), map[string]any{"time": map[string]int64{"archived": time.Now().UTC().UnixMilli()}})
	return projectSession(session), err
}

func (provider *Provider) UnarchiveSession(context.Context, domain.ActorContext, ports.AgentSessionRef) (ports.AgentSession, error) {
	return ports.AgentSession{}, &domain.AppError{Code: domain.ErrorCapabilityUnavailable, Message: "OpenCode 1.18.18 does not expose a verified unarchive operation", Retryable: false}
}

func (provider *Provider) DeleteSession(ctx context.Context, _ domain.ActorContext, ref ports.AgentSessionRef) error {
	if err := validateOpenCodeSessionRef(ref); err != nil {
		return err
	}
	return provider.client.DeleteSession(ctx, string(ref.ID))
}

func (provider *Provider) StartTurn(ctx context.Context, actor domain.ActorContext, session ports.AgentSessionRef, input ports.StartTurnInput) (ports.AgentTurnRef, ports.EventStream, error) {
	if err := validateOpenCodeSessionRef(session); err != nil {
		return ports.AgentTurnRef{}, nil, err
	}
	turnID, err := provider.codec.EncodeTurnKey(actor.TenantID + "\x00" + actor.OrgID + "\x00" + actor.UserID + "\x00" + string(session.ID) + "\x00" + input.OperationID)
	if err != nil {
		return ports.AgentTurnRef{}, nil, invalidOpenCodeArgument(err)
	}
	messageID := "msg_" + strings.TrimPrefix(string(turnID), "turn_")
	message := input.Message
	if input.CanvasContext != "" {
		message = input.CanvasContext + "\n\n" + message
	}
	admitted, err := provider.client.Prompt(ctx, string(session.ID), messageID, message)
	if err != nil {
		return ports.AgentTurnRef{}, nil, &domain.AppError{Code: domain.ErrorProviderResultUnknown, Message: "OpenCode prompt admission result is unknown", Retryable: false, Cause: err}
	}
	body, err := provider.client.SubscribeEvents(ctx, string(session.ID), strconv.FormatInt(admitted.Sequence, 10))
	if err != nil {
		return ports.AgentTurnRef{}, nil, err
	}
	return ports.AgentTurnRef{ID: turnID}, newOpenCodeEventStream(body, provider.codec, session.ID, turnID), nil
}

func (provider *Provider) CancelTurn(ctx context.Context, _ domain.ActorContext, session ports.AgentSessionRef, turn ports.AgentTurnRef) error {
	if err := validateOpenCodeSessionRef(session); err != nil {
		return err
	}
	if !turn.ID.Valid() || !strings.HasPrefix(string(turn.ID), "turn_") {
		return invalidOpenCodeArgument(errors.New("invalid OpenCode turn ID"))
	}
	wantedMessageID := "msg_" + strings.TrimPrefix(string(turn.ID), "turn_")
	found, err := provider.messageExists(ctx, string(session.ID), wantedMessageID)
	if err != nil {
		return err
	}
	if !found {
		return &domain.AppError{Code: domain.ErrorNotFound, Message: "agent turn not found", Retryable: false}
	}
	return provider.client.Interrupt(ctx, string(session.ID))
}

func (provider *Provider) messageExists(ctx context.Context, sessionID, messageID string) (bool, error) {
	cursor := ""
	seen := map[string]struct{}{}
	for {
		messages, next, err := provider.client.ListMessages(ctx, sessionID, cursor, 200)
		if err != nil {
			return false, err
		}
		for _, message := range messages {
			if message.ID == messageID {
				return true, nil
			}
		}
		if next == "" {
			return false, nil
		}
		if _, duplicate := seen[next]; duplicate {
			return false, errors.New("OpenCode returned a repeated message cursor")
		}
		seen[next] = struct{}{}
		cursor = next
	}
}

type openCodeEventStream struct {
	body      io.ReadCloser
	scanner   *bufio.Scanner
	codec     *agentid.Codec
	sessionID domain.ID
	turnID    domain.ID
	sequence  int64
	terminal  bool
}

func newOpenCodeEventStream(body io.ReadCloser, codec *agentid.Codec, sessionID, turnID domain.ID) *openCodeEventStream {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 64<<10), int(maxResponseBytes))
	return &openCodeEventStream{body: body, scanner: scanner, codec: codec, sessionID: sessionID, turnID: turnID}
}

func (stream *openCodeEventStream) Next(ctx context.Context) (domain.Event, error) {
	if stream.terminal {
		return domain.Event{}, io.EOF
	}
	for {
		select {
		case <-ctx.Done():
			return domain.Event{}, ctx.Err()
		default:
		}
		data, err := stream.nextSSEData()
		if err != nil {
			return domain.Event{}, err
		}
		event, ok, err := stream.project(data)
		if err != nil {
			return domain.Event{}, &domain.AppError{Code: domain.ErrorProviderResultUnknown, Message: "OpenCode event cannot be projected", Retryable: false, Cause: err}
		}
		if ok {
			stream.terminal = event.Type == domain.EventTurnCompleted || event.Type == domain.EventTurnFailed
			return event, nil
		}
	}
}

func (stream *openCodeEventStream) Close() error { return stream.body.Close() }

func (stream *openCodeEventStream) nextSSEData() (json.RawMessage, error) {
	var lines []string
	for stream.scanner.Scan() {
		line := stream.scanner.Text()
		if line == "" {
			if len(lines) == 0 {
				continue
			}
			return json.RawMessage(strings.Join(lines, "\n")), nil
		}
		if value, ok := strings.CutPrefix(line, "data:"); ok {
			lines = append(lines, strings.TrimPrefix(value, " "))
		}
	}
	if err := stream.scanner.Err(); err != nil {
		return nil, err
	}
	if len(lines) > 0 {
		return json.RawMessage(strings.Join(lines, "\n")), nil
	}
	return nil, io.EOF
}

func (stream *openCodeEventStream) project(raw json.RawMessage) (domain.Event, bool, error) {
	var event struct {
		ID      string `json:"id"`
		Type    string `json:"type"`
		Durable struct {
			Sequence int64 `json:"seq"`
		} `json:"durable"`
		Data struct {
			Timestamp int64          `json:"timestamp"`
			Text      string         `json:"text"`
			Finish    string         `json:"finish"`
			CallID    string         `json:"callID"`
			Tool      string         `json:"tool"`
			Input     map[string]any `json:"input"`
		} `json:"data"`
	}
	if json.Unmarshal(raw, &event) != nil || event.ID == "" || event.Type == "" {
		return domain.Event{}, false, errors.New("invalid OpenCode durable event")
	}
	var eventType domain.EventType
	var payload any
	switch event.Type {
	case "session.next.text.ended":
		eventType, payload = domain.EventMessageDelta, map[string]any{"delta": event.Data.Text}
	case "session.next.tool.called":
		callID, err := stream.codec.EncodeCallKey(string(stream.sessionID) + "\x00" + event.Data.CallID)
		if err != nil {
			return domain.Event{}, false, err
		}
		eventType, payload = domain.EventToolStarted, map[string]any{"call_id": callID, "server": "agent", "tool": event.Data.Tool, "arguments": event.Data.Input, "access": openCodeToolAccess(event.Data.Tool)}
	case "session.next.tool.success", "session.next.tool.failed":
		callID, err := stream.codec.EncodeCallKey(string(stream.sessionID) + "\x00" + event.Data.CallID)
		if err != nil {
			return domain.Event{}, false, err
		}
		status := "succeeded"
		if event.Type == "session.next.tool.failed" {
			status = "failed"
		}
		eventType, payload = domain.EventToolCompleted, map[string]any{"call_id": callID, "status": status, "duration_ms": 0}
	case "session.next.step.ended":
		if strings.Contains(strings.ToLower(event.Data.Finish), "tool") {
			return domain.Event{}, false, nil
		}
		eventType, payload = domain.EventTurnCompleted, map[string]any{"status": "succeeded"}
	case "session.next.step.failed":
		eventType, payload = domain.EventTurnFailed, map[string]any{"code": "agent_failed", "message": "Agent turn failed", "retryable": false}
	default:
		return domain.Event{}, false, nil
	}
	stream.sequence++
	publicEventID, err := stream.codec.EncodeEventKey(string(stream.sessionID) + "\x00" + string(stream.turnID) + "\x00" + event.ID)
	if err != nil {
		return domain.Event{}, false, err
	}
	content, _ := json.Marshal(payload)
	occurredAt := time.Now().UTC()
	if event.Data.Timestamp > 0 {
		occurredAt = unixMilliseconds(event.Data.Timestamp)
	}
	return domain.Event{ID: publicEventID, Type: eventType, SessionID: stream.sessionID, TurnID: stream.turnID, Sequence: stream.sequence, OccurredAt: occurredAt, Payload: content}, true, nil
}

func openCodeToolAccess(tool string) string {
	lower := strings.ToLower(tool)
	for _, marker := range []string{"get", "list", "read", "query", "search", "find"} {
		if strings.Contains(lower, marker) {
			return "read"
		}
	}
	return "execute"
}

func (provider *Provider) ResolveApproval(context.Context, domain.ActorContext, ports.AgentSessionRef, ports.ApprovalDecision) (ports.EventStream, error) {
	return nil, &domain.AppError{Code: domain.ErrorCapabilityUnavailable, Message: "OpenCode approval continuation is not connected", Retryable: false}
}

func (provider *Provider) readAllMessages(ctx context.Context, sessionID string) ([]ports.AgentMessage, error) {
	cursor := ""
	seen := map[string]struct{}{}
	var messages []ports.AgentMessage
	for {
		page, next, err := provider.client.ListMessages(ctx, sessionID, cursor, 200)
		if err != nil {
			return nil, err
		}
		for _, message := range page {
			role := ports.AgentMessageRole("")
			content := message.Text
			switch message.Type {
			case "user":
				role = ports.AgentMessageUser
			case "assistant":
				role = ports.AgentMessageAssistant
				var parts []string
				for _, part := range message.Content {
					if part.Type == "text" && part.Text != "" {
						parts = append(parts, part.Text)
					}
				}
				content = strings.Join(parts, "\n")
			default:
				continue
			}
			id, err := provider.codec.EncodeMessageKey(sessionID + "\x00" + message.ID)
			if err != nil {
				return nil, err
			}
			messages = append(messages, ports.AgentMessage{ID: id, Role: role, Content: content, CreatedAt: unixMilliseconds(message.Time.Created)})
		}
		if next == "" {
			return messages, nil
		}
		if _, duplicate := seen[next]; duplicate {
			return nil, errors.New("OpenCode returned a repeated message cursor")
		}
		seen[next] = struct{}{}
		cursor = next
	}
}

func projectSession(session Session) ports.AgentSession {
	status := domain.SessionActive
	if session.Time.Archived != nil {
		status = domain.SessionArchived
	}
	title := strings.TrimSpace(session.Title)
	if title == "" {
		title = "Untitled session"
	}
	return ports.AgentSession{Ref: ports.AgentSessionRef{ID: domain.ID(session.ID)}, Title: title, Status: status, CreatedAt: unixMilliseconds(session.Time.Created), UpdatedAt: unixMilliseconds(session.Time.Updated)}
}

func unixMilliseconds(value int64) time.Time { return time.UnixMilli(value).UTC() }

func validateOpenCodeSessionRef(ref ports.AgentSessionRef) error {
	if !ref.ID.Valid() || !strings.HasPrefix(string(ref.ID), "ses_") {
		return invalidOpenCodeArgument(errors.New("invalid OpenCode session ID"))
	}
	return nil
}

func invalidOpenCodeArgument(err error) error {
	return &domain.AppError{Code: domain.ErrorInvalidArgument, Message: "invalid agent identifier", Retryable: false, Cause: err}
}

var _ ports.AgentProvider = (*Provider)(nil)
