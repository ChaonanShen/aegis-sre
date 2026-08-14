package agentscope

import (
	"context"
	"errors"

	"github.com/1024XEngineer/aegis-sre/internal/domain"
	"github.com/1024XEngineer/aegis-sre/internal/ports"
)

type Scope struct {
	TenantID string
	OrgID    string
	UserID   string
}

type Provider struct {
	next  ports.AgentProvider
	scope Scope
}

func New(next ports.AgentProvider, scope Scope) (*Provider, error) {
	if next == nil {
		return nil, errors.New("scoped agent provider is required")
	}
	if scope.TenantID == "" || scope.OrgID == "" || scope.UserID == "" {
		return nil, errors.New("agent tenant, organization and user scope are required")
	}
	return &Provider{next: next, scope: scope}, nil
}

func (provider *Provider) Check(ctx context.Context) error { return provider.next.Check(ctx) }

func (provider *Provider) ListSessions(ctx context.Context, actor domain.ActorContext, input ports.ListAgentSessionsInput) (domain.Page[ports.AgentSession], error) {
	if err := provider.authorize(actor); err != nil {
		return domain.Page[ports.AgentSession]{}, err
	}
	return provider.next.ListSessions(ctx, actor, input)
}

func (provider *Provider) CreateSession(ctx context.Context, actor domain.ActorContext, input ports.CreateAgentSessionInput) (ports.AgentSession, error) {
	if err := provider.authorize(actor); err != nil {
		return ports.AgentSession{}, err
	}
	return provider.next.CreateSession(ctx, actor, input)
}

func (provider *Provider) ReadSession(ctx context.Context, actor domain.ActorContext, ref ports.AgentSessionRef) (ports.AgentSessionDetail, error) {
	if err := provider.authorize(actor); err != nil {
		return ports.AgentSessionDetail{}, err
	}
	return provider.next.ReadSession(ctx, actor, ref)
}

func (provider *Provider) RenameSession(ctx context.Context, actor domain.ActorContext, ref ports.AgentSessionRef, title string) (ports.AgentSession, error) {
	if err := provider.authorize(actor); err != nil {
		return ports.AgentSession{}, err
	}
	return provider.next.RenameSession(ctx, actor, ref, title)
}

func (provider *Provider) ArchiveSession(ctx context.Context, actor domain.ActorContext, ref ports.AgentSessionRef) (ports.AgentSession, error) {
	if err := provider.authorize(actor); err != nil {
		return ports.AgentSession{}, err
	}
	return provider.next.ArchiveSession(ctx, actor, ref)
}

func (provider *Provider) UnarchiveSession(ctx context.Context, actor domain.ActorContext, ref ports.AgentSessionRef) (ports.AgentSession, error) {
	if err := provider.authorize(actor); err != nil {
		return ports.AgentSession{}, err
	}
	return provider.next.UnarchiveSession(ctx, actor, ref)
}

func (provider *Provider) StartTurn(ctx context.Context, actor domain.ActorContext, ref ports.AgentSessionRef, input ports.StartTurnInput) (ports.AgentTurnRef, ports.EventStream, error) {
	if err := provider.authorize(actor); err != nil {
		return ports.AgentTurnRef{}, nil, err
	}
	return provider.next.StartTurn(ctx, actor, ref, input)
}

func (provider *Provider) CancelTurn(ctx context.Context, actor domain.ActorContext, session ports.AgentSessionRef, turn ports.AgentTurnRef) error {
	if err := provider.authorize(actor); err != nil {
		return err
	}
	return provider.next.CancelTurn(ctx, actor, session, turn)
}

func (provider *Provider) ResolveApproval(ctx context.Context, actor domain.ActorContext, session ports.AgentSessionRef, decision ports.ApprovalDecision) (ports.EventStream, error) {
	if err := provider.authorize(actor); err != nil {
		return nil, err
	}
	return provider.next.ResolveApproval(ctx, actor, session, decision)
}

func (provider *Provider) DeleteSession(ctx context.Context, actor domain.ActorContext, ref ports.AgentSessionRef) error {
	if err := provider.authorize(actor); err != nil {
		return err
	}
	return provider.next.DeleteSession(ctx, actor, ref)
}

func (provider *Provider) authorize(actor domain.ActorContext) error {
	if actor.TenantID != provider.scope.TenantID || actor.OrgID != provider.scope.OrgID || actor.UserID != provider.scope.UserID {
		return &domain.AppError{Code: domain.ErrorForbidden, Message: "actor is outside the configured agent scope", Retryable: false}
	}
	return nil
}

var _ ports.AgentProvider = (*Provider)(nil)
