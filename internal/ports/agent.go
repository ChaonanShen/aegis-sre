package ports

import (
	"context"
	"time"

	"github.com/1024XEngineer/aegis-sre/internal/domain"
)

type AgentSessionRef struct{ ID domain.ID }
type AgentTurnRef struct{ ID domain.ID }

type AgentSession struct {
	Ref       AgentSessionRef
	Title     string
	Status    domain.SessionStatus
	CreatedAt time.Time
	UpdatedAt time.Time
}

type AgentMessageRole string

const (
	AgentMessageUser      AgentMessageRole = "user"
	AgentMessageAssistant AgentMessageRole = "assistant"
	AgentMessageTool      AgentMessageRole = "tool"
)

type AgentMessage struct {
	ID        domain.ID
	Role      AgentMessageRole
	Content   string
	CreatedAt time.Time
}

type AgentSessionDetail struct {
	Session  AgentSession
	Messages []AgentMessage
}

type ListAgentSessionsInput struct {
	Page   domain.PageRequest
	Status domain.SessionStatus
}

type CreateAgentSessionInput struct {
	Title       string
	OperationID string
}

type StartTurnInput struct {
	Message       string
	CanvasContext string
	Mentions      []string
	OperationID   string
	FolderUID     string
	ServiceIDs    []domain.ID
}

type ApprovalDecisionValue string

const (
	ApprovalApproved ApprovalDecisionValue = "approved"
	ApprovalRejected ApprovalDecisionValue = "rejected"
)

type ApprovalDecision struct {
	ApprovalID domain.ID
	Decision   ApprovalDecisionValue
	Reason     string
}

type EventStream interface {
	Next(context.Context) (domain.Event, error)
	Close() error
}

type AgentProvider interface {
	Check(context.Context) error
	ListSessions(context.Context, domain.ActorContext, ListAgentSessionsInput) (domain.Page[AgentSession], error)
	CreateSession(context.Context, domain.ActorContext, CreateAgentSessionInput) (AgentSession, error)
	ReadSession(context.Context, domain.ActorContext, AgentSessionRef) (AgentSessionDetail, error)
	RenameSession(context.Context, domain.ActorContext, AgentSessionRef, string) (AgentSession, error)
	ArchiveSession(context.Context, domain.ActorContext, AgentSessionRef) (AgentSession, error)
	UnarchiveSession(context.Context, domain.ActorContext, AgentSessionRef) (AgentSession, error)
	StartTurn(context.Context, domain.ActorContext, AgentSessionRef, StartTurnInput) (AgentTurnRef, EventStream, error)
	CancelTurn(context.Context, domain.ActorContext, AgentSessionRef, AgentTurnRef) error
	ResolveApproval(context.Context, domain.ActorContext, AgentSessionRef, ApprovalDecision) (EventStream, error)
	DeleteSession(context.Context, domain.ActorContext, AgentSessionRef) error
}
