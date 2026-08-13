package application

import (
	"context"
	"time"

	"github.com/1024XEngineer/aegis-sre/internal/domain"
)

type SessionRepository interface {
	Create(context.Context, domain.ActorContext, domain.Session) error
	Get(context.Context, domain.ActorContext, domain.ID) (domain.Session, error)
	Update(context.Context, domain.ActorContext, domain.Session, domain.Version) error
}

type ProviderMappingKind string

const (
	MappingKnowledgeCollection ProviderMappingKind = "knowledge_collection"
	MappingKnowledgeDocument   ProviderMappingKind = "knowledge_document"
	MappingAgentSession        ProviderMappingKind = "agent_session"
	MappingPlaybook            ProviderMappingKind = "playbook"
	MappingPlaybookRun         ProviderMappingKind = "playbook_run"
)

type ProviderMapping struct {
	Kind        ProviderMappingKind
	BusinessID  domain.ID
	Provider    string
	ProviderID  string
	SyncVersion string
}

type ProviderMappingRepository interface {
	Upsert(context.Context, ProviderMapping) error
	Find(context.Context, ProviderMappingKind, domain.ID) (ProviderMapping, error)
}

type IdempotencyClaim struct {
	Actor       domain.ActorContext
	Operation   string
	Key         domain.IdempotencyKey
	RequestHash []byte
	TraceID     string
	ExpiresAt   time.Time
}

type IdempotencyRecord struct {
	IdempotencyClaim
	ResourceID domain.ID
	Status     string
}

type ClaimResult struct {
	Acquired bool
	Record   IdempotencyRecord
}

type IdempotencyRepository interface {
	Claim(context.Context, IdempotencyClaim) (ClaimResult, error)
	Complete(context.Context, IdempotencyClaim, domain.ID) error
}
