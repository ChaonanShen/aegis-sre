package codex

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"time"

	"github.com/1024XEngineer/aegis-sre/internal/adapters/agentid"
	"github.com/1024XEngineer/aegis-sre/internal/domain"
	"github.com/1024XEngineer/aegis-sre/internal/ports"
)

type rpcTransport interface {
	Call(context.Context, string, any, any) error
	Notifications() <-chan Notification
	Requests() <-chan Request
	Reply(Request, any) error
	ReplyError(Request, int, string) error
	Done() <-chan struct{}
}

type Provider struct {
	transport rpcTransport
	codec     *agentid.Codec
	cwd       string
	hub       *eventHub
}

func NewProvider(transport rpcTransport, codec *agentid.Codec, cwd string) (*Provider, error) {
	if transport == nil || codec == nil {
		return nil, errors.New("Codex transport and agent ID codec are required")
	}
	if cwd == "" || !filepath.IsAbs(cwd) {
		return nil, errors.New("Codex working directory must be absolute")
	}
	provider := &Provider{transport: transport, codec: codec, cwd: cwd}
	provider.hub = newEventHub(provider)
	go provider.hub.run()
	return provider, nil
}

func (provider *Provider) Check(context.Context) error {
	select {
	case <-provider.transport.Done():
		return errors.New("Codex App Server is unavailable")
	default:
		return nil
	}
}

func (provider *Provider) ListSessions(ctx context.Context, _ domain.ActorContext, input ports.ListAgentSessionsInput) (domain.Page[ports.AgentSession], error) {
	archived := input.Status == domain.SessionArchived
	page, err := provider.listThreads(ctx, archived, input.Page)
	if err != nil {
		return domain.Page[ports.AgentSession]{}, providerReadError(err)
	}
	items := make([]ports.AgentSession, 0, len(page.Data))
	for _, thread := range page.Data {
		session, err := provider.projectThread(thread, archived)
		if err != nil {
			return domain.Page[ports.AgentSession]{}, providerResultError(err)
		}
		items = append(items, session)
	}
	return domain.Page[ports.AgentSession]{Items: items, NextCursor: page.NextCursor, HasMore: page.NextCursor != ""}, nil
}

func (provider *Provider) CreateSession(ctx context.Context, _ domain.ActorContext, input ports.CreateAgentSessionInput) (ports.AgentSession, error) {
	var started struct {
		Thread codexThread `json:"thread"`
	}
	// Codex 0.144.4 不接受客户端 Thread ID 或幂等键；任何写入后的不确定错误都禁止自动重试。
	if err := provider.transport.Call(ctx, "thread/start", map[string]any{"cwd": provider.cwd, "ephemeral": false}, &started); err != nil {
		return ports.AgentSession{}, providerMutationError(err)
	}
	if started.Thread.ID == "" {
		return ports.AgentSession{}, providerResultError(errors.New("Codex returned no thread ID"))
	}
	if err := provider.transport.Call(ctx, "thread/name/set", map[string]any{"threadId": started.Thread.ID, "name": input.Title}, &struct{}{}); err != nil {
		return ports.AgentSession{}, providerMutationError(err)
	}
	started.Thread.Name = &input.Title
	session, err := provider.projectThread(started.Thread, false)
	if err != nil {
		return ports.AgentSession{}, providerResultError(err)
	}
	return session, nil
}

func (provider *Provider) ReadSession(ctx context.Context, _ domain.ActorContext, ref ports.AgentSessionRef) (ports.AgentSessionDetail, error) {
	threadID, err := provider.decodeSessionRef(ref)
	if err != nil {
		return ports.AgentSessionDetail{}, invalidAgentArgument(err)
	}
	thread, err := provider.readThread(ctx, threadID, true)
	if err != nil {
		return ports.AgentSessionDetail{}, providerReadError(err)
	}
	archived, err := provider.threadIsArchived(ctx, threadID)
	if err != nil {
		return ports.AgentSessionDetail{}, providerReadError(err)
	}
	session, err := provider.projectThread(thread, archived)
	if err != nil {
		return ports.AgentSessionDetail{}, providerResultError(err)
	}
	messages, err := provider.projectMessages(thread)
	if err != nil {
		return ports.AgentSessionDetail{}, providerResultError(err)
	}
	return ports.AgentSessionDetail{Session: session, Messages: messages}, nil
}

func (provider *Provider) RenameSession(ctx context.Context, actor domain.ActorContext, ref ports.AgentSessionRef, title string) (ports.AgentSession, error) {
	threadID, err := provider.decodeSessionRef(ref)
	if err != nil {
		return ports.AgentSession{}, invalidAgentArgument(err)
	}
	if err := provider.transport.Call(ctx, "thread/name/set", map[string]any{"threadId": threadID, "name": title}, &struct{}{}); err != nil {
		return ports.AgentSession{}, providerMutationError(err)
	}
	detail, err := provider.ReadSession(ctx, actor, ref)
	if err != nil {
		return ports.AgentSession{}, providerResultError(err)
	}
	return detail.Session, nil
}

func (provider *Provider) ArchiveSession(ctx context.Context, actor domain.ActorContext, ref ports.AgentSessionRef) (ports.AgentSession, error) {
	threadID, err := provider.decodeSessionRef(ref)
	if err != nil {
		return ports.AgentSession{}, invalidAgentArgument(err)
	}
	if err := provider.transport.Call(ctx, "thread/archive", map[string]any{"threadId": threadID}, &struct{}{}); err != nil {
		return ports.AgentSession{}, providerMutationError(err)
	}
	detail, err := provider.ReadSession(ctx, actor, ref)
	if err != nil {
		return ports.AgentSession{}, providerResultError(err)
	}
	return detail.Session, nil
}

func (provider *Provider) UnarchiveSession(ctx context.Context, _ domain.ActorContext, ref ports.AgentSessionRef) (ports.AgentSession, error) {
	threadID, err := provider.decodeSessionRef(ref)
	if err != nil {
		return ports.AgentSession{}, invalidAgentArgument(err)
	}
	var response struct {
		Thread codexThread `json:"thread"`
	}
	if err := provider.transport.Call(ctx, "thread/unarchive", map[string]any{"threadId": threadID}, &response); err != nil {
		return ports.AgentSession{}, providerMutationError(err)
	}
	session, err := provider.projectThread(response.Thread, false)
	if err != nil {
		return ports.AgentSession{}, providerResultError(err)
	}
	return session, nil
}

func (provider *Provider) DeleteSession(ctx context.Context, _ domain.ActorContext, ref ports.AgentSessionRef) error {
	threadID, err := provider.decodeSessionRef(ref)
	if err != nil {
		return invalidAgentArgument(err)
	}
	if err := provider.transport.Call(ctx, "thread/delete", map[string]any{"threadId": threadID}, &struct{}{}); err != nil {
		return providerMutationError(err)
	}
	return nil
}

func (provider *Provider) StartTurn(ctx context.Context, _ domain.ActorContext, ref ports.AgentSessionRef, input ports.StartTurnInput) (ports.AgentTurnRef, ports.EventStream, error) {
	threadID, err := provider.decodeSessionRef(ref)
	if err != nil {
		return ports.AgentTurnRef{}, nil, invalidAgentArgument(err)
	}
	var resumed struct {
		Thread codexThread `json:"thread"`
	}
	if err := provider.transport.Call(ctx, "thread/resume", map[string]any{"threadId": threadID, "cwd": provider.cwd}, &resumed); err != nil {
		return ports.AgentTurnRef{}, nil, providerMutationError(err)
	}
	var response struct {
		Turn codexTurn `json:"turn"`
	}
	message := input.Message
	if input.CanvasContext != "" {
		message = input.CanvasContext + "\n\n" + message
	}
	params := map[string]any{"threadId": threadID, "input": []map[string]any{{"type": "text", "text": message}}}
	if err := provider.transport.Call(ctx, "turn/start", params, &response); err != nil {
		return ports.AgentTurnRef{}, nil, providerMutationError(err)
	}
	turnID, err := provider.codec.EncodeTurnUUID(response.Turn.ID)
	if err != nil {
		return ports.AgentTurnRef{}, nil, providerResultError(err)
	}
	stream, err := provider.hub.register(threadID, response.Turn.ID)
	if err != nil {
		return ports.AgentTurnRef{}, nil, err
	}
	return ports.AgentTurnRef{ID: turnID}, stream, nil
}

func (provider *Provider) CancelTurn(ctx context.Context, _ domain.ActorContext, session ports.AgentSessionRef, turn ports.AgentTurnRef) error {
	threadID, err := provider.decodeSessionRef(session)
	if err != nil {
		return invalidAgentArgument(err)
	}
	turnID, err := provider.codec.DecodeTurnUUID(turn.ID)
	if err != nil {
		return invalidAgentArgument(err)
	}
	if err := provider.transport.Call(ctx, "turn/interrupt", map[string]any{"threadId": threadID, "turnId": turnID}, &struct{}{}); err != nil {
		return providerMutationError(err)
	}
	return nil
}

func (provider *Provider) ResolveApproval(_ context.Context, _ domain.ActorContext, session ports.AgentSessionRef, decision ports.ApprovalDecision) (ports.EventStream, error) {
	threadID, err := provider.decodeSessionRef(session)
	if err != nil {
		return nil, invalidAgentArgument(err)
	}
	return provider.hub.resolveApproval(threadID, decision)
}

type codexThreadPage struct {
	Data       []codexThread `json:"data"`
	NextCursor string        `json:"nextCursor"`
}

type codexThread struct {
	ID        string      `json:"id"`
	Name      *string     `json:"name"`
	Preview   string      `json:"preview"`
	CreatedAt int64       `json:"createdAt"`
	UpdatedAt int64       `json:"updatedAt"`
	Status    codexStatus `json:"status"`
	Turns     []codexTurn `json:"turns"`
}

type codexStatus struct {
	Type string `json:"type"`
}

type codexTurn struct {
	ID          string            `json:"id"`
	StartedAt   *int64            `json:"startedAt"`
	CompletedAt *int64            `json:"completedAt"`
	Items       []json.RawMessage `json:"items"`
}

func (provider *Provider) listThreads(ctx context.Context, archived bool, page domain.PageRequest) (codexThreadPage, error) {
	params := map[string]any{"archived": archived, "limit": page.Limit}
	if page.Cursor != "" {
		params["cursor"] = page.Cursor
	}
	var response codexThreadPage
	err := provider.transport.Call(ctx, "thread/list", params, &response)
	return response, err
}

func (provider *Provider) readThread(ctx context.Context, threadID string, includeTurns bool) (codexThread, error) {
	var response struct {
		Thread codexThread `json:"thread"`
	}
	err := provider.transport.Call(ctx, "thread/read", map[string]any{"threadId": threadID, "includeTurns": includeTurns}, &response)
	return response.Thread, err
}

// Codex Thread 本身没有 archived 字段，只能查询原生 archived 列表；不建立 Aegis 影子状态。
func (provider *Provider) threadIsArchived(ctx context.Context, threadID string) (bool, error) {
	cursor := ""
	seen := map[string]struct{}{}
	for {
		page, err := provider.listThreads(ctx, true, domain.PageRequest{Cursor: cursor, Limit: 200})
		if err != nil {
			return false, err
		}
		for _, thread := range page.Data {
			if thread.ID == threadID {
				return true, nil
			}
		}
		if page.NextCursor == "" {
			return false, nil
		}
		if _, duplicate := seen[page.NextCursor]; duplicate {
			return false, errors.New("Codex returned a repeated archive cursor")
		}
		seen[page.NextCursor] = struct{}{}
		cursor = page.NextCursor
	}
}

func (provider *Provider) projectThread(thread codexThread, archived bool) (ports.AgentSession, error) {
	id, err := provider.codec.EncodeUUID(thread.ID)
	if err != nil {
		return ports.AgentSession{}, err
	}
	title := strings.TrimSpace(thread.Preview)
	if thread.Name != nil && strings.TrimSpace(*thread.Name) != "" {
		title = strings.TrimSpace(*thread.Name)
	}
	if title == "" {
		title = "Untitled session"
	}
	if len([]rune(title)) > 200 {
		return ports.AgentSession{}, errors.New("Codex thread title exceeds public contract")
	}
	status := domain.SessionActive
	if archived {
		status = domain.SessionArchived
	} else if thread.Status.Type == "active" {
		status = domain.SessionBusy
	}
	messageCount := 0
	for _, turn := range thread.Turns {
		for _, raw := range turn.Items {
			var item struct {
				Type string `json:"type"`
			}
			if json.Unmarshal(raw, &item) == nil && (item.Type == "userMessage" || item.Type == "agentMessage") {
				messageCount++
			}
		}
	}
	preview := thread.Preview
	return ports.AgentSession{Ref: ports.AgentSessionRef{ID: id}, Title: title, Status: status, CreatedAt: time.Unix(thread.CreatedAt, 0).UTC(), UpdatedAt: time.Unix(thread.UpdatedAt, 0).UTC(), MessageCount: &messageCount, Preview: &preview}, nil
}

func (provider *Provider) projectMessages(thread codexThread) ([]ports.AgentMessage, error) {
	messages := make([]ports.AgentMessage, 0)
	for _, turn := range thread.Turns {
		for _, raw := range turn.Items {
			var item struct {
				ID      string `json:"id"`
				Type    string `json:"type"`
				Text    string `json:"text"`
				Content []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"content"`
			}
			if json.Unmarshal(raw, &item) != nil || item.ID == "" {
				return nil, errors.New("invalid Codex thread item")
			}
			role := ports.AgentMessageRole("")
			content := ""
			switch item.Type {
			case "userMessage":
				role = ports.AgentMessageUser
				var parts []string
				for _, part := range item.Content {
					if part.Type == "text" && part.Text != "" {
						parts = append(parts, part.Text)
					}
				}
				content = strings.Join(parts, "\n")
			case "agentMessage":
				role, content = ports.AgentMessageAssistant, item.Text
			default:
				continue
			}
			messageID, err := provider.codec.EncodeMessageKey(thread.ID + "\x00" + turn.ID + "\x00" + item.ID)
			if err != nil {
				return nil, err
			}
			createdAt := thread.UpdatedAt
			if turn.StartedAt != nil {
				createdAt = *turn.StartedAt
			}
			if role == ports.AgentMessageAssistant && turn.CompletedAt != nil {
				createdAt = *turn.CompletedAt
			}
			messages = append(messages, ports.AgentMessage{ID: messageID, Role: role, Content: content, CreatedAt: time.Unix(createdAt, 0).UTC()})
		}
	}
	return messages, nil
}

func (provider *Provider) decodeSessionRef(ref ports.AgentSessionRef) (string, error) {
	return provider.codec.DecodeUUID(ref.ID)
}

func invalidAgentArgument(err error) error {
	return &domain.AppError{Code: domain.ErrorInvalidArgument, Message: "invalid agent identifier", Retryable: false, Cause: err}
}

func providerReadError(err error) error {
	if errors.Is(err, context.DeadlineExceeded) {
		return &domain.AppError{Code: domain.ErrorProviderTimeout, Message: "Codex request timed out", Retryable: true, Cause: err}
	}
	return &domain.AppError{Code: domain.ErrorProviderUnavailable, Message: "Codex request failed", Retryable: true, Cause: err}
}

func providerMutationError(err error) error {
	return &domain.AppError{Code: domain.ErrorProviderResultUnknown, Message: "Codex mutation result is unknown", Retryable: false, Cause: err}
}

func providerResultError(err error) error {
	return &domain.AppError{Code: domain.ErrorProviderResultUnknown, Message: "Codex response cannot be projected", Retryable: false, Cause: err}
}

func capabilityUnavailable(message string) error {
	return &domain.AppError{Code: domain.ErrorCapabilityUnavailable, Message: message, Retryable: false}
}

var _ ports.AgentProvider = (*Provider)(nil)
