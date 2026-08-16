package canvas

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

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
	fake.projection.ActiveChartID = "cht_abcdefgh"
	fake.projection.Revision++
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

func TestServicePublishesBoundedCanvasUpdatedNotification(t *testing.T) {
	store := &storeFake{}
	agents := &contracttest.AgentProvider{SessionDetail: ports.AgentSessionDetail{Session: ports.AgentSession{Status: domain.SessionActive}}}
	service := New(agents, store)
	actor := domain.ActorContext{TenantID: "t", OrgID: "o", UserID: "u"}
	updates, cancel, err := service.Subscribe(context.Background(), actor, "ses_abcdefgh")
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()
	spec := domain.QueryChartSpec{DatasourceUID: "prom", Expression: "up", From: time.Date(2026, 8, 15, 0, 0, 0, 0, time.UTC), To: time.Date(2026, 8, 15, 1, 0, 0, 0, time.UTC), StepSeconds: 30, Title: "up", Visualization: "timeseries", VizConfig: json.RawMessage(`{"kind":"VizConfig","group":"timeseries","version":"v1","spec":{"options":{},"fieldConfig":{"defaults":{},"overrides":[]}}}`)}
	projection, err := service.PublishQueryChart(context.Background(), actor, ports.PublishQueryChartInput{SessionID: "ses_abcdefgh", OperationID: "operation-1", RequestHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", Spec: spec})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case event := <-updates:
		if event.Type != domain.EventCanvasUpdated || event.SessionID != "ses_abcdefgh" || event.Sequence == 0 || !bytes.Contains(event.Payload, []byte(string(projection.ActiveChartID))) {
			t.Fatalf("event=%+v", event)
		}
	case <-time.After(time.Second):
		t.Fatal("Canvas update notification not delivered")
	}
	metrics := service.MetricsSnapshot()
	if metrics["writes_total"] != 1 || metrics["notifications_total"] != 1 || metrics["errors_total"] != 0 {
		t.Fatalf("unexpected metrics: %+v", metrics)
	}
}

func TestServiceMetricsDoNotContainRequestIdentifiers(t *testing.T) {
	service := New(nil, nil)
	metrics := service.MetricsSnapshot()
	for key := range metrics {
		if bytes.Contains([]byte(key), []byte("session")) || bytes.Contains([]byte(key), []byte("chart")) || bytes.Contains([]byte(key), []byte("datasource")) {
			t.Fatalf("metric key leaks request identifier: %q", key)
		}
	}
}
