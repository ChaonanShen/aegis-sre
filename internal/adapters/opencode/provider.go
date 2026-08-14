package opencode

import (
	"context"
	"errors"
	"net/http"
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
	session, err := provider.client.CreateSession(ctx, string(id))
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

func (provider *Provider) StartTurn(context.Context, domain.ActorContext, ports.AgentSessionRef, ports.StartTurnInput) (ports.AgentTurnRef, ports.EventStream, error) {
	return ports.AgentTurnRef{}, nil, &domain.AppError{Code: domain.ErrorCapabilityUnavailable, Message: "OpenCode event streaming is not connected", Retryable: false}
}

func (provider *Provider) CancelTurn(context.Context, domain.ActorContext, ports.AgentSessionRef, ports.AgentTurnRef) error {
	return &domain.AppError{Code: domain.ErrorCapabilityUnavailable, Message: "OpenCode turn cancellation is not connected", Retryable: false}
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
