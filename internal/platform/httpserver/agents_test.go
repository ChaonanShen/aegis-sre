package httpserver

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/1024XEngineer/aegis-sre/internal/domain"
	"github.com/1024XEngineer/aegis-sre/internal/platform/config"
	"github.com/1024XEngineer/aegis-sre/internal/ports"
	"github.com/1024XEngineer/aegis-sre/internal/ports/contracttest"
)

type agentHTTPFake struct {
	contracttest.AgentProvider
	listInput      ports.ListAgentSessionsInput
	createInput    ports.CreateAgentSessionInput
	startInput     ports.StartTurnInput
	sessionRef     ports.AgentSessionRef
	turnRef        ports.AgentTurnRef
	approval       ports.ApprovalDecision
	renameTitle    string
	operation      string
	renameCalls    int
	archiveCalls   int
	unarchiveCalls int
	deleteCalls    int
	cancelCalls    int
	approvalCalls  int
	checkErr       error
}

func (fake *agentHTTPFake) Check(context.Context) error { return fake.checkErr }

func (fake *agentHTTPFake) ListSessions(_ context.Context, _ domain.ActorContext, input ports.ListAgentSessionsInput) (domain.Page[ports.AgentSession], error) {
	fake.listInput = input
	return fake.Sessions, fake.Err
}

func (fake *agentHTTPFake) CreateSession(_ context.Context, _ domain.ActorContext, input ports.CreateAgentSessionInput) (ports.AgentSession, error) {
	fake.createInput = input
	return fake.Session, fake.Err
}

func (fake *agentHTTPFake) ReadSession(_ context.Context, _ domain.ActorContext, ref ports.AgentSessionRef) (ports.AgentSessionDetail, error) {
	fake.sessionRef = ref
	return fake.SessionDetail, fake.Err
}

func (fake *agentHTTPFake) RenameSession(_ context.Context, _ domain.ActorContext, ref ports.AgentSessionRef, title string) (ports.AgentSession, error) {
	fake.renameCalls++
	fake.sessionRef, fake.renameTitle = ref, title
	return fake.Session, fake.Err
}

func (fake *agentHTTPFake) ArchiveSession(_ context.Context, _ domain.ActorContext, ref ports.AgentSessionRef) (ports.AgentSession, error) {
	fake.archiveCalls++
	fake.sessionRef = ref
	return fake.Session, fake.Err
}

func (fake *agentHTTPFake) UnarchiveSession(_ context.Context, _ domain.ActorContext, ref ports.AgentSessionRef) (ports.AgentSession, error) {
	fake.unarchiveCalls++
	fake.sessionRef = ref
	return fake.Session, fake.Err
}

func (fake *agentHTTPFake) DeleteSession(_ context.Context, _ domain.ActorContext, ref ports.AgentSessionRef) error {
	fake.deleteCalls++
	fake.sessionRef = ref
	return fake.Err
}

func (fake *agentHTTPFake) StartTurn(_ context.Context, _ domain.ActorContext, ref ports.AgentSessionRef, input ports.StartTurnInput) (ports.AgentTurnRef, ports.EventStream, error) {
	fake.sessionRef, fake.startInput = ref, input
	return fake.Turn, &contracttest.EventStream{Events: fake.Events}, fake.Err
}

func (fake *agentHTTPFake) CancelTurn(_ context.Context, _ domain.ActorContext, session ports.AgentSessionRef, turn ports.AgentTurnRef) error {
	fake.cancelCalls++
	fake.sessionRef, fake.turnRef = session, turn
	return fake.Err
}

func (fake *agentHTTPFake) ResolveApproval(_ context.Context, _ domain.ActorContext, session ports.AgentSessionRef, decision ports.ApprovalDecision) (ports.EventStream, error) {
	fake.approvalCalls++
	fake.sessionRef, fake.approval = session, decision
	return &contracttest.EventStream{Events: fake.Events}, fake.Err
}

func agentFixture() ports.AgentSession {
	return ports.AgentSession{
		Ref: ports.AgentSessionRef{ID: "ses_abcdefgh"}, Title: "Investigate latency", Status: domain.SessionActive,
		CreatedAt: time.Date(2026, 8, 14, 1, 0, 0, 0, time.UTC), UpdatedAt: time.Date(2026, 8, 14, 2, 0, 0, 0, time.UTC),
	}
}

func agentHandler(fake ports.AgentProvider) http.Handler {
	return New(config.Config{Endpoints: map[config.Capability]string{}}, nil, WithAgentProvider(fake)).Handler
}

func TestAgentSessionListAndCreateUseStablePublicContract(t *testing.T) {
	t.Parallel()
	session := agentFixture()
	fake := &agentHTTPFake{AgentProvider: contracttest.AgentProvider{Session: session, Sessions: domain.Page[ports.AgentSession]{Items: []ports.AgentSession{session}, NextCursor: "next", HasMore: true}}}
	handler := agentHandler(fake)

	list := httptest.NewRecorder()
	handler.ServeHTTP(list, actorRequest(http.MethodGet, "/api/v1/sessions?status=archived&cursor=before&limit=25", ""))
	if list.Code != http.StatusOK || fake.listInput.Status != domain.SessionArchived || fake.listInput.Page.Cursor != "before" || fake.listInput.Page.Limit != 25 {
		t.Fatalf("status = %d, input = %#v, body = %s", list.Code, fake.listInput, list.Body.String())
	}
	if !strings.Contains(list.Body.String(), `"next_cursor":"next"`) || strings.Contains(list.Body.String(), "provider") || strings.Contains(list.Body.String(), "folder_uid") {
		t.Fatalf("unstable session response: %s", list.Body.String())
	}

	createRequest := actorRequest(http.MethodPost, "/api/v1/sessions", `{"title":"Investigate latency","folder_uid":"folder-a"}`)
	createRequest.Header.Set("Idempotency-Key", "create-session-1")
	createRequest.Header.Set("X-Aegis-Folder-UID", "folder-a")
	created := httptest.NewRecorder()
	handler.ServeHTTP(created, createRequest)
	if created.Code != http.StatusCreated || fake.createInput.Title != "Investigate latency" || fake.createInput.OperationID != "create-session-1" {
		t.Fatalf("status = %d, input = %#v, body = %s", created.Code, fake.createInput, created.Body.String())
	}
	if strings.Contains(created.Body.String(), "folder_uid") {
		t.Fatalf("request-only folder leaked: %s", created.Body.String())
	}
}

func TestAgentSessionDetailAndMutationsRouteToExplicitProviderOperations(t *testing.T) {
	t.Parallel()
	session := agentFixture()
	fake := &agentHTTPFake{AgentProvider: contracttest.AgentProvider{Session: session, SessionDetail: ports.AgentSessionDetail{
		Session: session, Messages: []ports.AgentMessage{{ID: "msg_abcdefgh", Role: ports.AgentMessageAssistant, Content: "Found it", CreatedAt: session.UpdatedAt}},
	}}}
	handler := agentHandler(fake)

	detail := httptest.NewRecorder()
	handler.ServeHTTP(detail, actorRequest(http.MethodGet, "/api/v1/sessions/ses_abcdefgh", ""))
	if detail.Code != http.StatusOK || !strings.Contains(detail.Body.String(), `"role":"assistant"`) || fake.sessionRef.ID != "ses_abcdefgh" {
		t.Fatalf("status = %d, ref = %#v, body = %s", detail.Code, fake.sessionRef, detail.Body.String())
	}

	cases := []struct {
		body string
		call *int
	}{
		{body: `{"title":"Renamed"}`, call: &fake.renameCalls},
		{body: `{"status":"archived"}`, call: &fake.archiveCalls},
		{body: `{"status":"active"}`, call: &fake.unarchiveCalls},
	}
	for _, test := range cases {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, actorRequest(http.MethodPatch, "/api/v1/sessions/ses_abcdefgh", test.body))
		if response.Code != http.StatusOK || *test.call != 1 {
			t.Fatalf("body = %s, status = %d, calls = %d, response = %s", test.body, response.Code, *test.call, response.Body.String())
		}
	}
	if fake.renameTitle != "Renamed" {
		t.Fatalf("rename title = %q", fake.renameTitle)
	}

	deleted := httptest.NewRecorder()
	handler.ServeHTTP(deleted, actorRequest(http.MethodDelete, "/api/v1/sessions/ses_abcdefgh", ""))
	if deleted.Code != http.StatusNoContent || fake.deleteCalls != 1 {
		t.Fatalf("status = %d, delete calls = %d", deleted.Code, fake.deleteCalls)
	}
}

func TestStartTurnStreamsLifecycleAndForwardsTrustedContext(t *testing.T) {
	t.Parallel()
	fake := &agentHTTPFake{AgentProvider: contracttest.AgentProvider{
		Turn:   ports.AgentTurnRef{ID: "turn_abcdefgh"},
		Events: []domain.Event{{ID: "evt_ijklmnop", Type: domain.EventTurnCompleted, SessionID: "ses_abcdefgh", TurnID: "turn_abcdefgh", Sequence: 1, OccurredAt: time.Date(2026, 8, 14, 3, 0, 0, 0, time.UTC), Payload: json.RawMessage(`{"status":"succeeded"}`)}},
	}}
	request := actorRequest(http.MethodPost, "/api/v1/sessions/ses_abcdefgh/turns:stream", `{"message":"check latency","mentions":["service:api"]}`)
	request.Header.Set("Idempotency-Key", "start-turn-1")
	request.Header.Set("X-Aegis-Folder-UID", "folder-a")
	response := httptest.NewRecorder()
	agentHandler(fake).ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Header().Get("Content-Type") != "text/event-stream" {
		t.Fatalf("status = %d, headers = %v, body = %s", response.Code, response.Header(), response.Body.String())
	}
	body := response.Body.String()
	if !strings.Contains(body, "event: turn.started") || !strings.Contains(body, "event: turn.completed") || !strings.Contains(body, `"session_id":"ses_abcdefgh"`) || !strings.Contains(body, `"turn_id":"turn_abcdefgh"`) {
		t.Fatalf("incomplete lifecycle stream: %s", body)
	}
	if fake.startInput.OperationID != "start-turn-1" || fake.startInput.FolderUID != "folder-a" || fake.startInput.Message != "check latency" || len(fake.startInput.Mentions) != 1 {
		t.Fatalf("start input = %#v", fake.startInput)
	}
}

func TestTurnCancellationAndApprovalResolutionAreExplicit(t *testing.T) {
	t.Parallel()
	fake := &agentHTTPFake{AgentProvider: contracttest.AgentProvider{Events: []domain.Event{{ID: "evt_abcdefgh", Type: domain.EventApprovalResolved, SessionID: "ses_abcdefgh", TurnID: "turn_abcdefgh", Sequence: 2, OccurredAt: time.Now(), Payload: json.RawMessage(`{"decision":"approved"}`)}}}}
	handler := agentHandler(fake)

	cancelRequest := actorRequest(http.MethodPost, "/api/v1/sessions/ses_abcdefgh/turns/turn_abcdefgh:cancel", "")
	cancelRequest.Header.Set("Idempotency-Key", "cancel-turn-1")
	cancel := httptest.NewRecorder()
	handler.ServeHTTP(cancel, cancelRequest)
	if cancel.Code != http.StatusNoContent || fake.cancelCalls != 1 || fake.turnRef.ID != "turn_abcdefgh" {
		t.Fatalf("status = %d, calls = %d, turn = %#v", cancel.Code, fake.cancelCalls, fake.turnRef)
	}

	approvalRequest := actorRequest(http.MethodPost, "/api/v1/sessions/ses_abcdefgh/approvals/apr_abcdefgh:resolve", `{"decision":"approved","reason":"safe"}`)
	approvalRequest.Header.Set("Idempotency-Key", "resolve-approval-1")
	approval := httptest.NewRecorder()
	handler.ServeHTTP(approval, approvalRequest)
	if approval.Code != http.StatusOK || fake.approvalCalls != 1 || fake.approval.ApprovalID != "apr_abcdefgh" || fake.approval.Decision != ports.ApprovalApproved || fake.approval.Reason != "safe" {
		t.Fatalf("status = %d, calls = %d, decision = %#v, body = %s", approval.Code, fake.approvalCalls, fake.approval, approval.Body.String())
	}
}

func TestAgentHandlersRejectAmbiguousOrUntrustedInputBeforeProvider(t *testing.T) {
	t.Parallel()
	fake := &agentHTTPFake{AgentProvider: contracttest.AgentProvider{Session: agentFixture(), Turn: ports.AgentTurnRef{ID: "turn_abcdefgh"}}}
	handler := agentHandler(fake)

	tests := []struct {
		method string
		path   string
		body   string
		key    string
	}{
		{method: http.MethodGet, path: "/api/v1/sessions?limit=201"},
		{method: http.MethodGet, path: "/api/v1/sessions?status=busy"},
		{method: http.MethodGet, path: "/api/v1/sessions/not-valid"},
		{method: http.MethodPatch, path: "/api/v1/sessions/ses_abcdefgh", body: `{"title":"x","status":"archived"}`},
		{method: http.MethodPost, path: "/api/v1/sessions/ses_abcdefgh/turns:stream", body: `{"message":""}`, key: "start-turn-1"},
		{method: http.MethodPost, path: "/api/v1/sessions/ses_abcdefgh/turns/bad:cancel", key: "cancel-turn-1"},
	}
	for _, test := range tests {
		request := actorRequest(test.method, test.path, test.body)
		if test.key != "" {
			request.Header.Set("Idempotency-Key", test.key)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("%s %s status = %d, body = %s", test.method, test.path, response.Code, response.Body.String())
		}
	}
	if fake.renameCalls+fake.archiveCalls+fake.unarchiveCalls+fake.cancelCalls != 0 {
		t.Fatalf("provider mutation called for rejected input: %#v", fake)
	}

	untrusted := actorRequest(http.MethodPost, "/api/v1/sessions", `{"title":"x","folder_uid":"body-folder"}`)
	untrusted.Header.Set("Idempotency-Key", "create-session-1")
	untrusted.Header.Set("X-Aegis-Folder-UID", "trusted-folder")
	untrustedResponse := httptest.NewRecorder()
	handler.ServeHTTP(untrustedResponse, untrusted)
	if untrustedResponse.Code != http.StatusForbidden || fake.createInput.OperationID != "" {
		t.Fatalf("status = %d, input = %#v", untrustedResponse.Code, fake.createInput)
	}
}

func TestAgentProviderErrorsUseStablePublicCodesAndHealth(t *testing.T) {
	t.Parallel()
	fake := &agentHTTPFake{AgentProvider: contracttest.AgentProvider{Err: &domain.AppError{Code: domain.ErrorProviderResultUnknown, Message: "secret provider detail", Retryable: false}}, checkErr: errors.New("down")}
	handler := agentHandler(fake)

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, actorRequest(http.MethodGet, "/api/v1/sessions", ""))
	if response.Code != http.StatusBadGateway || !strings.Contains(response.Body.String(), `"code":"provider_result_unknown"`) || strings.Contains(response.Body.String(), "secret provider detail") {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}

	ready := httptest.NewRecorder()
	handler.ServeHTTP(ready, httptest.NewRequest(http.MethodGet, "/health/ready", nil))
	if ready.Code != http.StatusServiceUnavailable || !strings.Contains(ready.Body.String(), `"agent":"degraded"`) {
		t.Fatalf("status = %d, body = %s", ready.Code, ready.Body.String())
	}
}
