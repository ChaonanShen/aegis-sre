package ports

import (
	"context"

	"github.com/1024XEngineer/aegis-sre/internal/domain"
)

type AgentSessionRef struct{ OpaqueID string }

type CreateAgentSessionInput struct{ Title string }
type StartTurnInput struct {
	Message  string
	Mentions []string
}
type ApprovalDecision struct {
	ApprovalID string
	Approved   bool
	Reason     string
}

type EventStream interface {
	Next(context.Context) (domain.Event, error)
	Close() error
}

type AgentProvider interface {
	CreateSession(context.Context, domain.ActorContext, CreateAgentSessionInput) (AgentSessionRef, error)
	StartTurn(context.Context, domain.ActorContext, AgentSessionRef, StartTurnInput) (EventStream, error)
	CancelTurn(context.Context, domain.ActorContext, AgentSessionRef, string) error
	ResolveApproval(context.Context, domain.ActorContext, AgentSessionRef, ApprovalDecision) (EventStream, error)
	DeleteSession(context.Context, domain.ActorContext, AgentSessionRef) error
}
