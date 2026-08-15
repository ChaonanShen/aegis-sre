// Package canvas coordinates Agent session ownership with the Canvas projection store.
package canvas

import (
	"context"

	"github.com/1024XEngineer/aegis-sre/internal/domain"
	"github.com/1024XEngineer/aegis-sre/internal/ports"
)

type Service struct {
	agents ports.AgentProvider
	store  ports.CanvasStore
}

func New(agents ports.AgentProvider, store ports.CanvasStore) *Service {
	return &Service{agents: agents, store: store}
}

func (service *Service) Get(ctx context.Context, actor domain.ActorContext, sessionID domain.ID) (domain.CanvasProjection, error) {
	if err := service.validate(ctx, actor, sessionID, false); err != nil {
		return domain.CanvasProjection{}, err
	}
	return service.store.Get(ctx, actor, sessionID)
}

func (service *Service) PublishQueryChart(ctx context.Context, actor domain.ActorContext, input ports.PublishQueryChartInput) (domain.CanvasProjection, error) {
	if err := service.validate(ctx, actor, input.SessionID, true); err != nil {
		return domain.CanvasProjection{}, err
	}
	if service.store == nil {
		return domain.CanvasProjection{}, unavailable("Canvas persistence is not configured", nil)
	}
	return service.store.PublishQueryChart(ctx, actor, input)
}

func (service *Service) UpdateLayout(ctx context.Context, actor domain.ActorContext, input ports.UpdateCanvasInput) (domain.CanvasProjection, error) {
	if err := service.validate(ctx, actor, input.SessionID, true); err != nil {
		return domain.CanvasProjection{}, err
	}
	if service.store == nil {
		return domain.CanvasProjection{}, unavailable("Canvas persistence is not configured", nil)
	}
	return service.store.UpdateLayout(ctx, actor, input)
}

func (service *Service) Delete(ctx context.Context, actor domain.ActorContext, sessionID domain.ID) error {
	if service.store == nil {
		return nil
	}
	if err := actor.Validate(); err != nil {
		return invalid(err.Error(), err)
	}
	if !sessionID.Valid() {
		return invalid("session ID is invalid", nil)
	}
	return service.store.Delete(ctx, actor, sessionID)
}

func (service *Service) validate(ctx context.Context, actor domain.ActorContext, sessionID domain.ID, write bool) error {
	if service.store == nil {
		return unavailable("Canvas persistence is not configured", nil)
	}
	if service.agents == nil {
		return unavailable("Agent session provider is not configured", nil)
	}
	if err := actor.Validate(); err != nil {
		return invalid(err.Error(), err)
	}
	if !sessionID.Valid() {
		return invalid("session ID is invalid", nil)
	}
	detail, err := service.agents.ReadSession(ctx, actor, ports.AgentSessionRef{ID: sessionID})
	if err != nil {
		return err
	}
	if write && detail.Session.Status != domain.SessionActive {
		return conflict("archived sessions are read-only", nil)
	}
	return nil
}

func invalid(message string, cause error) *domain.AppError {
	return &domain.AppError{Code: domain.ErrorInvalidArgument, Message: message, Cause: cause}
}

func conflict(message string, cause error) *domain.AppError {
	return &domain.AppError{Code: domain.ErrorConflict, Message: message, Cause: cause}
}

func unavailable(message string, cause error) *domain.AppError {
	return &domain.AppError{Code: domain.ErrorCapabilityUnavailable, Message: message, Retryable: true, Cause: cause}
}
