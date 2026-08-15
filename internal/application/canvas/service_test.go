package canvas

import (
	"context"
	"errors"
	"testing"

	"github.com/1024XEngineer/aegis-sre/internal/domain"
	"github.com/1024XEngineer/aegis-sre/internal/ports"
	"github.com/1024XEngineer/aegis-sre/internal/ports/contracttest"
)

type storeFake struct {
	projection domain.CanvasProjection
	getCalls   int
}

func (fake *storeFake) Check(context.Context) error { return nil }
func (fake *storeFake) Close() error                { return nil }
func (fake *storeFake) Get(context.Context, domain.ActorContext, domain.ID) (domain.CanvasProjection, error) {
	fake.getCalls++
	return fake.projection, nil
}
func (fake *storeFake) PublishQueryChart(_ context.Context, _ domain.ActorContext, input ports.PublishQueryChartInput) (domain.CanvasProjection, error) {
	fake.projection.SessionID = input.SessionID
	return fake.projection, nil
}
func (fake *storeFake) UpdateLayout(_ context.Context, _ domain.ActorContext, input ports.UpdateCanvasInput) (domain.CanvasProjection, error) {
	fake.projection.SessionID = input.SessionID
	return fake.projection, nil
}
func (fake *storeFake) Delete(context.Context, domain.ActorContext, domain.ID) error { return nil }

func TestServiceValidatesSessionBeforeReadingCanvas(t *testing.T) {
	store := &storeFake{}
	agents := &contracttest.AgentProvider{SessionDetail: ports.AgentSessionDetail{Session: ports.AgentSession{Status: domain.SessionActive}}}
	service := New(agents, store)
	projection, err := service.Get(context.Background(), domain.ActorContext{TenantID: "t", OrgID: "o", UserID: "u"}, domain.ID("ses_abcdefgh"))
	if err != nil || store.getCalls != 1 || projection.SessionID != "" {
		t.Fatalf("projection=%+v calls=%d err=%v", projection, store.getCalls, err)
	}
}

func TestServiceRejectsWritesToArchivedSession(t *testing.T) {
	store := &storeFake{}
	agents := &contracttest.AgentProvider{SessionDetail: ports.AgentSessionDetail{Session: ports.AgentSession{Status: domain.SessionArchived}}}
	service := New(agents, store)
	_, err := service.PublishQueryChart(context.Background(), domain.ActorContext{TenantID: "t", OrgID: "o", UserID: "u"}, ports.PublishQueryChartInput{SessionID: "ses_abcdefgh", OperationID: "operation-1"})
	var appErr *domain.AppError
	if !errors.As(err, &appErr) || appErr.Code != domain.ErrorConflict {
		t.Fatalf("err=%v", err)
	}
}

func TestServiceDoesNotTreatMissingCanvasStoreAsEmpty(t *testing.T) {
	agents := &contracttest.AgentProvider{SessionDetail: ports.AgentSessionDetail{Session: ports.AgentSession{Status: domain.SessionActive}}}
	service := New(agents, nil)
	_, err := service.Get(context.Background(), domain.ActorContext{TenantID: "t", OrgID: "o", UserID: "u"}, "ses_abcdefgh")
	var appErr *domain.AppError
	if !errors.As(err, &appErr) || appErr.Code != domain.ErrorCapabilityUnavailable {
		t.Fatalf("err=%v", err)
	}
}
