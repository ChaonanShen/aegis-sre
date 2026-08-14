package codex

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/1024XEngineer/aegis-sre/internal/adapters/agentid"
	"github.com/1024XEngineer/aegis-sre/internal/domain"
	"github.com/1024XEngineer/aegis-sre/internal/ports"
)

const (
	threadUUID = "01989f4a-3b2c-7def-8123-0123456789ab"
	turnUUID   = "01989f4a-3b2c-7def-8123-0123456789ac"
)

type rpcCall struct {
	method string
	params map[string]any
}

type rpcFake struct {
	mu             sync.Mutex
	responses      map[string][]json.RawMessage
	errors         map[string]error
	calls          []rpcCall
	done           chan struct{}
	notifications  chan Notification
	requests       chan Request
	replies        []map[string]any
	replyErrors    []wireError
	beforeResponse map[string]func()
	stopOnce       sync.Once
}

func newRPCFake() *rpcFake {
	return &rpcFake{responses: map[string][]json.RawMessage{}, errors: map[string]error{}, done: make(chan struct{}), notifications: make(chan Notification, 32), requests: make(chan Request, 8), beforeResponse: map[string]func(){}}
}

func (fake *rpcFake) Call(_ context.Context, method string, params, target any) error {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	encodedParams, _ := json.Marshal(params)
	var values map[string]any
	_ = json.Unmarshal(encodedParams, &values)
	fake.calls = append(fake.calls, rpcCall{method: method, params: values})
	if err := fake.errors[method]; err != nil {
		return err
	}
	if callback := fake.beforeResponse[method]; callback != nil {
		callback()
	}
	queue := fake.responses[method]
	if len(queue) == 0 {
		return nil
	}
	fake.responses[method] = queue[1:]
	return json.Unmarshal(queue[0], target)
}

func (fake *rpcFake) Done() <-chan struct{}              { return fake.done }
func (fake *rpcFake) Notifications() <-chan Notification { return fake.notifications }
func (fake *rpcFake) Requests() <-chan Request           { return fake.requests }
func (fake *rpcFake) Reply(_ Request, result any) error {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	encoded, _ := json.Marshal(result)
	var value map[string]any
	_ = json.Unmarshal(encoded, &value)
	fake.replies = append(fake.replies, value)
	return fake.errors["reply"]
}
func (fake *rpcFake) ReplyError(_ Request, code int, message string) error {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	fake.replyErrors = append(fake.replyErrors, wireError{Code: code, Message: message})
	return nil
}
func (fake *rpcFake) stop() { fake.stopOnce.Do(func() { close(fake.done) }) }

func (fake *rpcFake) enqueue(method, response string) {
	fake.responses[method] = append(fake.responses[method], json.RawMessage(response))
}

func newCodexProvider(t *testing.T, fake *rpcFake) (*Provider, *agentid.Codec) {
	t.Helper()
	codec, err := agentid.New([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatal(err)
	}
	provider, err := NewProvider(fake, codec, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(fake.stop)
	return provider, codec
}

func codexThreadJSON(name string, status string, turns string) string {
	nameJSON, _ := json.Marshal(name)
	return `{"id":"` + threadUUID + `","name":` + string(nameJSON) + `,"preview":"preview","createdAt":1786672800,"updatedAt":1786676400,"status":{"type":"` + status + `"},"turns":` + turns + `}`
}

func TestProviderListsAndCreatesSessionsWithoutLeakingCodexIDs(t *testing.T) {
	t.Parallel()
	fake := newRPCFake()
	fake.enqueue("thread/list", `{"data":[`+codexThreadJSON("Latency", "active", `[]`)+`],"nextCursor":"next-page"}`)
	fake.enqueue("thread/start", `{"thread":`+codexThreadJSON("", "idle", `[]`)+`}`)
	fake.enqueue("thread/name/set", `{}`)
	provider, _ := newCodexProvider(t, fake)

	page, err := provider.ListSessions(context.Background(), domain.ActorContext{}, ports.ListAgentSessionsInput{Page: domain.PageRequest{Cursor: "cursor", Limit: 25}, Status: domain.SessionActive})
	if err != nil || len(page.Items) != 1 || !page.HasMore || page.Items[0].Status != domain.SessionBusy || string(page.Items[0].Ref.ID) == threadUUID {
		t.Fatalf("page = %#v, err = %v", page, err)
	}
	if fake.calls[0].method != "thread/list" || fake.calls[0].params["archived"] != false || fake.calls[0].params["cursor"] != "cursor" || fake.calls[0].params["limit"] != float64(25) {
		t.Fatalf("list call = %#v", fake.calls[0])
	}

	created, err := provider.CreateSession(context.Background(), domain.ActorContext{}, ports.CreateAgentSessionInput{Title: "New title", OperationID: "must-not-be-forwarded"})
	if err != nil || created.Title != "New title" || created.Ref.ID == "" || string(created.Ref.ID) == threadUUID {
		t.Fatalf("created = %#v, err = %v", created, err)
	}
	if fake.calls[1].method != "thread/start" || fake.calls[1].params["ephemeral"] != false || fake.calls[1].params["cwd"] == "" {
		t.Fatalf("start call = %#v", fake.calls[1])
	}
	if _, leaked := fake.calls[1].params["operationId"]; leaked {
		t.Fatalf("unsupported idempotency key forwarded: %#v", fake.calls[1])
	}
	if fake.calls[2].method != "thread/name/set" || fake.calls[2].params["threadId"] != threadUUID || fake.calls[2].params["name"] != "New title" {
		t.Fatalf("name call = %#v", fake.calls[2])
	}
}

func TestProviderReadsArchivedSessionAndProjectsMessageHistory(t *testing.T) {
	t.Parallel()
	turns := `[{"id":"` + turnUUID + `","startedAt":1786673000,"completedAt":1786673100,"items":[` +
		`{"id":"user-item","type":"userMessage","content":[{"type":"text","text":"check api"}]},` +
		`{"id":"agent-item","type":"agentMessage","text":"api is healthy"},` +
		`{"id":"reasoning-item","type":"reasoning","summary":["private"]}` + `]}]`
	fake := newRPCFake()
	fake.enqueue("thread/read", `{"thread":`+codexThreadJSON("History", "idle", turns)+`}`)
	fake.enqueue("thread/list", `{"data":[],"nextCursor":"archive-next"}`)
	fake.enqueue("thread/list", `{"data":[`+codexThreadJSON("History", "idle", `[]`)+`],"nextCursor":null}`)
	provider, codec := newCodexProvider(t, fake)
	publicID, _ := codec.EncodeUUID(threadUUID)

	detail, err := provider.ReadSession(context.Background(), domain.ActorContext{}, ports.AgentSessionRef{ID: publicID})
	if err != nil || detail.Session.Status != domain.SessionArchived || len(detail.Messages) != 2 {
		t.Fatalf("detail = %#v, err = %v", detail, err)
	}
	if detail.Messages[0].Role != ports.AgentMessageUser || detail.Messages[0].Content != "check api" || detail.Messages[1].Role != ports.AgentMessageAssistant || detail.Messages[1].Content != "api is healthy" {
		t.Fatalf("messages = %#v", detail.Messages)
	}
	for _, message := range detail.Messages {
		if string(message.ID) == "user-item" || string(message.ID) == "agent-item" || !message.ID.Valid() {
			t.Fatalf("provider message ID leaked: %q", message.ID)
		}
	}
	if fake.calls[1].params["archived"] != true || fake.calls[2].params["cursor"] != "archive-next" {
		t.Fatalf("archive scan calls = %#v", fake.calls[1:])
	}
}

func TestProviderMapsRenameArchiveUnarchiveAndDelete(t *testing.T) {
	t.Parallel()
	fake := newRPCFake()
	fake.enqueue("thread/name/set", `{}`)
	fake.enqueue("thread/read", `{"thread":`+codexThreadJSON("Renamed", "idle", `[]`)+`}`)
	fake.enqueue("thread/list", `{"data":[]}`)
	fake.enqueue("thread/archive", `{}`)
	fake.enqueue("thread/read", `{"thread":`+codexThreadJSON("Renamed", "idle", `[]`)+`}`)
	fake.enqueue("thread/list", `{"data":[`+codexThreadJSON("Renamed", "idle", `[]`)+`]}`)
	fake.enqueue("thread/unarchive", `{"thread":`+codexThreadJSON("Renamed", "idle", `[]`)+`}`)
	fake.enqueue("thread/delete", `{}`)
	provider, codec := newCodexProvider(t, fake)
	publicID, _ := codec.EncodeUUID(threadUUID)
	ref := ports.AgentSessionRef{ID: publicID}

	renamed, err := provider.RenameSession(context.Background(), domain.ActorContext{}, ref, "Renamed")
	if err != nil || renamed.Title != "Renamed" || renamed.Status != domain.SessionActive {
		t.Fatalf("renamed = %#v, err = %v", renamed, err)
	}
	archived, err := provider.ArchiveSession(context.Background(), domain.ActorContext{}, ref)
	if err != nil || archived.Status != domain.SessionArchived {
		t.Fatalf("archived = %#v, err = %v", archived, err)
	}
	unarchived, err := provider.UnarchiveSession(context.Background(), domain.ActorContext{}, ref)
	if err != nil || unarchived.Status != domain.SessionActive {
		t.Fatalf("unarchived = %#v, err = %v", unarchived, err)
	}
	if err := provider.DeleteSession(context.Background(), domain.ActorContext{}, ref); err != nil {
		t.Fatal(err)
	}
	want := []string{"thread/name/set", "thread/read", "thread/list", "thread/archive", "thread/read", "thread/list", "thread/unarchive", "thread/delete"}
	for index, method := range want {
		if fake.calls[index].method != method {
			t.Fatalf("calls[%d] = %q, want %q; all = %#v", index, fake.calls[index].method, method, fake.calls)
		}
	}
}

func TestProviderFailsClosedForInvalidIDsAndUncertainMutations(t *testing.T) {
	t.Parallel()
	fake := newRPCFake()
	provider, _ := newCodexProvider(t, fake)
	if _, err := provider.ReadSession(context.Background(), domain.ActorContext{}, ports.AgentSessionRef{ID: "ses_abcdefgh"}); err == nil {
		t.Fatal("unauthenticated public ID must be rejected")
	} else {
		var appErr *domain.AppError
		if !errors.As(err, &appErr) || appErr.Code != domain.ErrorInvalidArgument || appErr.Retryable {
			t.Fatalf("error = %#v", err)
		}
	}
	if len(fake.calls) != 0 {
		t.Fatalf("provider called for invalid ID: %#v", fake.calls)
	}

	fake.errors["thread/start"] = context.DeadlineExceeded
	_, err := provider.CreateSession(context.Background(), domain.ActorContext{}, ports.CreateAgentSessionInput{Title: "Unknown"})
	var appErr *domain.AppError
	if !errors.As(err, &appErr) || appErr.Code != domain.ErrorProviderResultUnknown || appErr.Retryable {
		t.Fatalf("mutation error = %#v", err)
	}
}

func TestProviderHealthTracksTransportLifetime(t *testing.T) {
	t.Parallel()
	fake := newRPCFake()
	provider, _ := newCodexProvider(t, fake)
	if err := provider.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
	fake.stop()
	if err := provider.Check(context.Background()); err == nil {
		t.Fatal("closed transport reported healthy")
	}
}

func TestProviderStartsTurnWithoutDroppingEarlyNotificationsAndCancelsExplicitly(t *testing.T) {
	t.Parallel()
	fake := newRPCFake()
	fake.enqueue("thread/resume", `{"thread":`+codexThreadJSON("Turn", "idle", `[]`)+`}`)
	fake.enqueue("turn/start", `{"turn":{"id":"`+turnUUID+`","status":"inProgress","items":[]}}`)
	fake.enqueue("turn/interrupt", `{}`)
	fake.beforeResponse["turn/start"] = func() {
		fake.notifications <- Notification{Method: "item/agentMessage/delta", Params: json.RawMessage(`{"threadId":"` + threadUUID + `","turnId":"` + turnUUID + `","itemId":"agent-item","delta":"hello"}`)}
	}
	provider, codec := newCodexProvider(t, fake)
	sessionID, _ := codec.EncodeUUID(threadUUID)
	turn, stream, err := provider.StartTurn(context.Background(), domain.ActorContext{}, ports.AgentSessionRef{ID: sessionID}, ports.StartTurnInput{Message: "hello", OperationID: "not-native-idempotency"})
	if err != nil || stream == nil || !turn.ID.Valid() {
		t.Fatalf("turn = %#v, stream = %T, err = %v", turn, stream, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	event, err := stream.Next(ctx)
	if err != nil || event.Type != domain.EventMessageDelta || event.Sequence != 1 || string(event.Payload) != `{"delta":"hello"}` || event.SessionID != sessionID || event.TurnID != turn.ID {
		t.Fatalf("event = %#v, err = %v", event, err)
	}
	fake.notifications <- Notification{Method: "turn/completed", Params: json.RawMessage(`{"threadId":"` + threadUUID + `","turn":{"id":"` + turnUUID + `","status":"completed","items":[]}}`)}
	terminal, err := stream.Next(ctx)
	if err != nil || terminal.Type != domain.EventTurnCompleted || terminal.Sequence != 2 || !strings.Contains(string(terminal.Payload), `"succeeded"`) {
		t.Fatalf("terminal = %#v, err = %v", terminal, err)
	}
	if _, err := stream.Next(ctx); !errors.Is(err, io.EOF) {
		t.Fatalf("terminal stream error = %v", err)
	}
	if err := provider.CancelTurn(context.Background(), domain.ActorContext{}, ports.AgentSessionRef{ID: sessionID}, turn); err != nil {
		t.Fatal(err)
	}
	last := fake.calls[len(fake.calls)-1]
	if last.method != "turn/interrupt" || last.params["threadId"] != threadUUID || last.params["turnId"] != turnUUID {
		t.Fatalf("interrupt call = %#v", last)
	}
}

func TestProviderPausesForApprovalAndRegistersContinuationBeforeReply(t *testing.T) {
	t.Parallel()
	fake := newRPCFake()
	fake.enqueue("thread/resume", `{"thread":`+codexThreadJSON("Approval", "idle", `[]`)+`}`)
	fake.enqueue("turn/start", `{"turn":{"id":"`+turnUUID+`","status":"inProgress","items":[]}}`)
	provider, codec := newCodexProvider(t, fake)
	sessionID, _ := codec.EncodeUUID(threadUUID)
	_, initial, err := provider.StartTurn(context.Background(), domain.ActorContext{}, ports.AgentSessionRef{ID: sessionID}, ports.StartTurnInput{Message: "deploy"})
	if err != nil {
		t.Fatal(err)
	}
	fake.requests <- Request{ID: json.RawMessage(`"approval-rpc-1"`), Method: "item/commandExecution/requestApproval", Params: json.RawMessage(`{"threadId":"` + threadUUID + `","turnId":"` + turnUUID + `","itemId":"command-item","command":"kubectl rollout restart","reason":"requires write"}`)}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	requested, err := initial.Next(ctx)
	if err != nil || requested.Type != domain.EventApprovalRequested {
		t.Fatalf("requested = %#v, err = %v", requested, err)
	}
	var payload struct {
		ApprovalID domain.ID `json:"approval_id"`
	}
	if json.Unmarshal(requested.Payload, &payload) != nil || !payload.ApprovalID.Valid() {
		t.Fatalf("payload = %s", requested.Payload)
	}
	if _, err := initial.Next(ctx); !errors.Is(err, io.EOF) {
		t.Fatalf("approval must pause initial stream: %v", err)
	}
	continuation, err := provider.ResolveApproval(context.Background(), domain.ActorContext{}, ports.AgentSessionRef{ID: sessionID}, ports.ApprovalDecision{ApprovalID: payload.ApprovalID, Decision: ports.ApprovalApproved, Reason: "approved by operator"})
	if err != nil {
		t.Fatal(err)
	}
	resolved, err := continuation.Next(ctx)
	if err != nil || resolved.Type != domain.EventApprovalResolved || !strings.Contains(string(resolved.Payload), `"approved"`) {
		t.Fatalf("resolved = %#v, err = %v", resolved, err)
	}
	if len(fake.replies) != 1 || fake.replies[0]["decision"] != "accept" {
		t.Fatalf("replies = %#v", fake.replies)
	}
	fake.notifications <- Notification{Method: "turn/completed", Params: json.RawMessage(`{"threadId":"` + threadUUID + `","turn":{"id":"` + turnUUID + `","status":"interrupted","items":[]}}`)}
	terminal, err := continuation.Next(ctx)
	if err != nil || terminal.Type != domain.EventTurnCompleted || terminal.Sequence != 2 || !strings.Contains(string(terminal.Payload), `"interrupted"`) {
		t.Fatalf("terminal = %#v, err = %v", terminal, err)
	}
}
