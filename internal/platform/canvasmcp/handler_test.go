package canvasmcp

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/1024XEngineer/aegis-sre/internal/adapters/canvassqlite"
	canvasapp "github.com/1024XEngineer/aegis-sre/internal/application/canvas"
	"github.com/1024XEngineer/aegis-sre/internal/domain"
	"github.com/1024XEngineer/aegis-sre/internal/ports"
	"github.com/1024XEngineer/aegis-sre/internal/ports/contracttest"
)

func TestHandlerRequiresIndependentTokenAndActor(t *testing.T) {
	if _, err := NewHandler(nil, Config{TokenFile: "token", TenantID: "t", OrgID: "o", UserID: "u"}); err == nil {
		t.Fatal("nil service accepted")
	}
	if _, err := NewHandler(canvasapp.New(&contracttest.AgentProvider{}, nil), Config{TenantID: "t", OrgID: "o", UserID: "u"}); err == nil {
		t.Fatal("missing token accepted")
	}
}

func TestPublishPersistsOnlyAfterActiveRangeValidation(t *testing.T) {
	store, err := canvassqlite.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	agent := &contracttest.AgentProvider{SessionDetail: ports.AgentSessionDetail{Session: ports.AgentSession{Ref: ports.AgentSessionRef{ID: "ses_abcdefgh"}, Status: domain.SessionActive}}}
	svc := &handler{service: canvasapp.New(agent, store), actor: domain.ActorContext{TenantID: "t", OrgID: "o", UserID: "u"}}
	input := validPublishInput("ses_abcdefgh")
	_, output, err := svc.publish(context.Background(), nil, input)
	if err != nil || output.ChartID == "" || output.CanvasRevision != 1 {
		t.Fatalf("output=%+v err=%v", output, err)
	}
	input.To = input.From
	if _, _, err := svc.publish(context.Background(), nil, input); err == nil {
		t.Fatal("instant/empty range was accepted")
	}
}

func validPublishInput(operation string) publishInput {
	return publishInput{SessionID: "ses_abcdefgh", OperationID: operation + "-key", DatasourceUID: "prom-main", Expression: "up", From: time.Date(2026, 8, 15, 0, 0, 0, 0, time.UTC), To: time.Date(2026, 8, 15, 1, 0, 0, 0, time.UTC), StepSeconds: 30, Title: "Availability", Visualization: "timeseries", VizConfig: map[string]any{"kind": "VizConfig", "group": "timeseries", "version": "v1", "spec": map[string]any{"options": map[string]any{}, "fieldConfig": map[string]any{}}}}
}

func TestHandlerRejectsMissingOrWrongBearerToken(t *testing.T) {
	path := filepath.Join(t.TempDir(), "canvas-token")
	if err := os.WriteFile(path, []byte("canvas-secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	handler, err := NewHandler(canvasapp.New(&contracttest.AgentProvider{}, nil), Config{TokenFile: path, TenantID: "t", OrgID: "o", UserID: "u"})
	if err != nil {
		t.Fatal(err)
	}
	for _, authorization := range []string{"", "Bearer wrong"} {
		request := httptest.NewRequest(http.MethodPost, "/mcp/canvas", nil)
		if authorization != "" {
			request.Header.Set("Authorization", authorization)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("authorization=%q status=%d", authorization, response.Code)
		}
	}
}
