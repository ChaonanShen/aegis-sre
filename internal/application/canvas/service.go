// Package canvas coordinates Agent session ownership with the Canvas projection store.
package canvas

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/1024XEngineer/aegis-sre/internal/domain"
	"github.com/1024XEngineer/aegis-sre/internal/ports"
)

type Service struct {
	agents    ports.AgentProvider
	store     ports.CanvasStore
	mu        sync.RWMutex
	nextEvent uint64
	subs      map[string]map[chan domain.Event]struct{}
	metrics   canvasMetrics
}

type canvasMetrics struct {
	reads             atomic.Uint64
	writes            atomic.Uint64
	updates           atomic.Uint64
	deletes           atomic.Uint64
	errors            atomic.Uint64
	revisionConflicts atomic.Uint64
	notifications     atomic.Uint64
	notificationDrops atomic.Uint64
	readDurationNS    atomic.Uint64
	writeDurationNS   atomic.Uint64
}

func New(agents ports.AgentProvider, store ports.CanvasStore) *Service {
	return &Service{agents: agents, store: store, subs: make(map[string]map[chan domain.Event]struct{})}
}

func (service *Service) Check(ctx context.Context) error {
	if service == nil || service.store == nil {
		return unavailable("Canvas persistence is not configured", nil)
	}
	return service.store.Check(ctx)
}

func (service *Service) Get(ctx context.Context, actor domain.ActorContext, sessionID domain.ID) (domain.CanvasProjection, error) {
	started := time.Now()
	service.metrics.reads.Add(1)
	defer func() { service.metrics.readDurationNS.Add(uint64(time.Since(started).Nanoseconds())) }()
	if err := service.validate(ctx, actor, sessionID, false); err != nil {
		service.recordError(err)
		return domain.CanvasProjection{}, err
	}
	projection, err := service.store.Get(ctx, actor, sessionID)
	service.recordError(err)
	return projection, err
}

func (service *Service) PublishQueryChart(ctx context.Context, actor domain.ActorContext, input ports.PublishQueryChartInput) (domain.CanvasProjection, error) {
	started := time.Now()
	service.metrics.writes.Add(1)
	defer func() { service.metrics.writeDurationNS.Add(uint64(time.Since(started).Nanoseconds())) }()
	if err := service.validate(ctx, actor, input.SessionID, true); err != nil {
		service.recordError(err)
		return domain.CanvasProjection{}, err
	}
	if service.store == nil {
		err := unavailable("Canvas persistence is not configured", nil)
		service.recordError(err)
		return domain.CanvasProjection{}, err
	}
	projection, err := service.store.PublishQueryChart(ctx, actor, input)
	service.recordError(err)
	if err == nil && projection.ActiveChartID != "" {
		service.publishEvent(actor, input.SessionID, projection.ActiveChartID, input.OperationID, projection.Revision)
	}
	return projection, err
}

// Subscribe exposes a bounded, best-effort notification stream. The Canvas
// projection remains the source of truth when a notification is dropped.
func (service *Service) Subscribe(ctx context.Context, actor domain.ActorContext, sessionID domain.ID) (<-chan domain.Event, func(), error) {
	if err := actor.Validate(); err != nil || !sessionID.Valid() {
		return nil, func() {}, invalid("Canvas subscription scope is invalid", err)
	}
	key := scopeKey(actor, sessionID)
	ch := make(chan domain.Event, 8)
	service.mu.Lock()
	if service.subs[key] == nil {
		service.subs[key] = make(map[chan domain.Event]struct{})
	}
	service.subs[key][ch] = struct{}{}
	service.mu.Unlock()
	var once sync.Once
	cancel := func() {
		once.Do(func() {
			service.mu.Lock()
			if subscribers := service.subs[key]; subscribers != nil {
				delete(subscribers, ch)
				if len(subscribers) == 0 {
					delete(service.subs, key)
				}
			}
			close(ch)
			service.mu.Unlock()
		})
	}
	go func() {
		<-ctx.Done()
		cancel()
	}()
	return ch, cancel, nil
}

func (service *Service) publishEvent(actor domain.ActorContext, sessionID, chartID domain.ID, operationID string, revision int64) {
	sequence := atomic.AddUint64(&service.nextEvent, 1)
	payload, _ := json.Marshal(map[string]any{"chart_id": chartID, "operation_id": operationID, "revision": revision})
	event := domain.Event{ID: domain.ID(fmt.Sprintf("evt_canvas_%016x", sequence)), Type: domain.EventCanvasUpdated, SessionID: sessionID, Sequence: int64(sequence), OccurredAt: time.Now().UTC(), Payload: payload}
	key := scopeKey(actor, sessionID)
	service.mu.RLock()
	defer service.mu.RUnlock()
	for subscriber := range service.subs[key] {
		select {
		case subscriber <- event:
			service.metrics.notifications.Add(1)
		default:
			service.metrics.notificationDrops.Add(1)
		}
	}
}

func scopeKey(actor domain.ActorContext, sessionID domain.ID) string {
	return actor.TenantID + "\x00" + actor.OrgID + "\x00" + actor.UserID + "\x00" + string(sessionID)
}

func (service *Service) UpdateLayout(ctx context.Context, actor domain.ActorContext, input ports.UpdateCanvasInput) (domain.CanvasProjection, error) {
	started := time.Now()
	service.metrics.writes.Add(1)
	service.metrics.updates.Add(1)
	defer func() { service.metrics.writeDurationNS.Add(uint64(time.Since(started).Nanoseconds())) }()
	if err := service.validate(ctx, actor, input.SessionID, true); err != nil {
		service.recordError(err)
		return domain.CanvasProjection{}, err
	}
	if service.store == nil {
		err := unavailable("Canvas persistence is not configured", nil)
		service.recordError(err)
		return domain.CanvasProjection{}, err
	}
	projection, err := service.store.UpdateLayout(ctx, actor, input)
	service.recordError(err)
	return projection, err
}

func (service *Service) Delete(ctx context.Context, actor domain.ActorContext, sessionID domain.ID) error {
	started := time.Now()
	service.metrics.writes.Add(1)
	service.metrics.deletes.Add(1)
	defer func() { service.metrics.writeDurationNS.Add(uint64(time.Since(started).Nanoseconds())) }()
	if service.store == nil {
		return nil
	}
	if err := actor.Validate(); err != nil {
		appErr := invalid(err.Error(), err)
		service.recordError(appErr)
		return appErr
	}
	if !sessionID.Valid() {
		err := invalid("session ID is invalid", nil)
		service.recordError(err)
		return err
	}
	err := service.store.Delete(ctx, actor, sessionID)
	service.recordError(err)
	return err
}

// MetricsSnapshot returns fixed-name, low-cardinality counters for operational use.
func (service *Service) MetricsSnapshot() map[string]uint64 {
	return map[string]uint64{
		"reads_total":                      service.metrics.reads.Load(),
		"writes_total":                     service.metrics.writes.Load(),
		"updates_total":                    service.metrics.updates.Load(),
		"deletes_total":                    service.metrics.deletes.Load(),
		"errors_total":                     service.metrics.errors.Load(),
		"revision_conflicts_total":         service.metrics.revisionConflicts.Load(),
		"notifications_total":              service.metrics.notifications.Load(),
		"notification_drops_total":         service.metrics.notificationDrops.Load(),
		"read_duration_nanoseconds_total":  service.metrics.readDurationNS.Load(),
		"write_duration_nanoseconds_total": service.metrics.writeDurationNS.Load(),
	}
}

func (service *Service) recordError(err error) {
	if err == nil {
		return
	}
	service.metrics.errors.Add(1)
	var appErr *domain.AppError
	if errors.As(err, &appErr) && appErr.Code == domain.ErrorConflict {
		service.metrics.revisionConflicts.Add(1)
	}
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
