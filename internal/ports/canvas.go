package ports

import (
	"context"

	"github.com/1024XEngineer/aegis-sre/internal/domain"
)

type PublishQueryChartInput struct {
	SessionID   domain.ID
	OperationID string
	RequestHash string
	Spec        domain.QueryChartSpec
}

type UpdateCanvasInput struct {
	SessionID        domain.ID
	ExpectedRevision int64
	Visible          bool
	Layout           domain.CanvasLayout
	ActiveChartID    domain.ID
	OrderedChartIDs  []domain.ID
}

type CanvasStore interface {
	Check(context.Context) error
	Get(context.Context, domain.ActorContext, domain.ID) (domain.CanvasProjection, error)
	PublishQueryChart(context.Context, domain.ActorContext, PublishQueryChartInput) (domain.CanvasProjection, error)
	UpdateLayout(context.Context, domain.ActorContext, UpdateCanvasInput) (domain.CanvasProjection, error)
	Delete(context.Context, domain.ActorContext, domain.ID) error
	Close() error
}

// CanvasStoreMetrics is optional operational data exposed by a store adapter.
// Keys and values must remain low-cardinality and must not contain identifiers.
type CanvasStoreMetrics interface {
	MetricsSnapshot(context.Context) (map[string]uint64, error)
}
