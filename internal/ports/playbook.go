package ports

import (
	"context"

	"github.com/1024XEngineer/aegis-sre/internal/domain"
)

type PlaybookRef struct{ OpaqueID string }
type PlaybookRunRef struct{ OpaqueID string }
type ValidationIssue struct {
	Path    string
	Message string
}
type RunPlaybookInput struct{ Parameters map[string]string }

type PlaybookProvider interface {
	Create(context.Context, domain.ActorContext, []byte) (PlaybookRef, error)
	Update(context.Context, domain.ActorContext, PlaybookRef, []byte) error
	Delete(context.Context, domain.ActorContext, PlaybookRef) error
	Validate(context.Context, domain.ActorContext, []byte) ([]ValidationIssue, error)
	StartRun(context.Context, domain.ActorContext, PlaybookRef, RunPlaybookInput) (PlaybookRunRef, error)
	CancelRun(context.Context, domain.ActorContext, PlaybookRunRef) error
	RetryRun(context.Context, domain.ActorContext, PlaybookRunRef) (PlaybookRunRef, error)
	StreamRun(context.Context, domain.ActorContext, PlaybookRunRef, int64) (EventStream, error)
}
