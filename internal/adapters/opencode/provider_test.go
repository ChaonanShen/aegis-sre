package opencode

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/1024XEngineer/aegis-sre/internal/adapters/agentid"
	"github.com/1024XEngineer/aegis-sre/internal/domain"
	"github.com/1024XEngineer/aegis-sre/internal/ports"
)

func newOpenCodeProvider(t *testing.T, handler http.Handler) (*Provider, *httptest.Server) {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client, err := NewClient(server.URL, server.Client(), "", nil)
	if err != nil {
		t.Fatal(err)
	}
	codec, _ := agentid.New([]byte("0123456789abcdef0123456789abcdef"))
	provider, err := NewProvider(client, codec)
	if err != nil {
		t.Fatal(err)
	}
	return provider, server
}

func TestProviderCreatesCallerOwnedSessionIdempotently(t *testing.T) {
	t.Parallel()
	created := false
	var sessionID string
	provider, _ := newOpenCodeProvider(t, http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch {
		case request.Method == http.MethodGet && request.URL.Path == "/config":
			_, _ = w.Write([]byte(`{"model":"deepseek/deepseek-v4-flash"}`))
		case request.Method == http.MethodPost && request.URL.Path == "/api/session":
			var body map[string]any
			_ = json.NewDecoder(request.Body).Decode(&body)
			sessionID, _ = body["id"].(string)
			if _, leaked := body["title"]; leaked {
				t.Error("V2 create must not receive title")
			}
			model, _ := body["model"].(map[string]any)
			if model["providerID"] != "deepseek" || model["id"] != "deepseek-v4-flash" {
				t.Errorf("model = %#v", body["model"])
			}
			if created {
				w.WriteHeader(http.StatusConflict)
				return
			}
			created = true
			_, _ = w.Write([]byte(`{"data":{"id":"` + sessionID + `","title":"","time":{"created":1786672800000,"updated":1786672800000}}}`))
		case request.Method == http.MethodGet && request.URL.Path == "/api/session/"+sessionID:
			_, _ = w.Write([]byte(`{"data":{"id":"` + sessionID + `","title":"Investigate","time":{"created":1786672800000,"updated":1786672900000}}}`))
		case request.Method == http.MethodPost && request.URL.Path == "/api/session/"+sessionID+"/model":
			w.WriteHeader(http.StatusNoContent)
		case request.Method == http.MethodPatch && request.URL.Path == "/session/"+sessionID:
			_, _ = w.Write([]byte(`{"id":"` + sessionID + `","title":"Investigate","time":{"created":1786672800000,"updated":1786672900000}}`))
		default:
			t.Errorf("unexpected request: %s %s", request.Method, request.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	actor := domain.ActorContext{TenantID: "tenant", OrgID: "org", UserID: "user"}
	input := ports.CreateAgentSessionInput{Title: "Investigate", OperationID: "create-session-1"}
	first, err := provider.CreateSession(context.Background(), actor, input)
	if err != nil || !first.Ref.ID.Valid() || first.Title != "Investigate" || string(first.Ref.ID) != sessionID {
		t.Fatalf("first = %#v, err = %v", first, err)
	}
	second, err := provider.CreateSession(context.Background(), actor, input)
	if err != nil || second.Ref.ID != first.Ref.ID || second.Title != "Investigate" {
		t.Fatalf("second = %#v, err = %v", second, err)
	}
}

func TestProviderFiltersNativeArchiveStateAndProjectsPagedMessages(t *testing.T) {
	t.Parallel()
	provider, _ := newOpenCodeProvider(t, http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/api/session":
			_, _ = w.Write([]byte(`{"data":[{"id":"ses_active123","title":"Active","time":{"created":1786672800000,"updated":1786672900000}},{"id":"ses_archive1","title":"Archived","time":{"created":1786672800000,"updated":1786672900000,"archived":1786673000000}}],"cursor":{"next":"next"}}`))
		case "/api/session/ses_archive1":
			_, _ = w.Write([]byte(`{"data":{"id":"ses_archive1","title":"Archived","time":{"created":1786672800000,"updated":1786672900000,"archived":1786673000000}}}`))
		case "/api/session/ses_archive1/message":
			if request.URL.Query().Get("cursor") == "page-2" {
				_, _ = w.Write([]byte(`{"data":[{"id":"msg_assistant","type":"assistant","time":{"created":1786672820000},"agent":"build","model":{"providerID":"x","modelID":"y"},"content":[{"type":"text","text":"done"}]}],"cursor":{}}`))
				return
			}
			_, _ = w.Write([]byte(`{"data":[{"id":"msg_user","type":"user","time":{"created":1786672810000},"text":"check"}],"cursor":{"next":"page-2"}}`))
		default:
			t.Errorf("unexpected path: %s", request.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	page, err := provider.ListSessions(context.Background(), domain.ActorContext{}, ports.ListAgentSessionsInput{Page: domain.PageRequest{Limit: 50}, Status: domain.SessionArchived})
	if err != nil || len(page.Items) != 1 || page.Items[0].Ref.ID != "ses_archive1" || !page.HasMore {
		t.Fatalf("page = %#v, err = %v", page, err)
	}
	detail, err := provider.ReadSession(context.Background(), domain.ActorContext{}, ports.AgentSessionRef{ID: "ses_archive1"})
	if err != nil || detail.Session.Status != domain.SessionArchived || len(detail.Messages) != 2 || detail.Messages[0].Content != "check" || detail.Messages[1].Content != "done" {
		t.Fatalf("detail = %#v, err = %v", detail, err)
	}
	for _, message := range detail.Messages {
		if !message.ID.Valid() || strings.Contains(string(message.ID), "msg_user") || strings.Contains(string(message.ID), "assistant") {
			t.Fatalf("message ID leaked: %q", message.ID)
		}
	}
}

func TestProviderUsesNativeMutationsAndReportsUnarchiveGap(t *testing.T) {
	t.Parallel()
	var patches []map[string]any
	provider, _ := newOpenCodeProvider(t, http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.Method == http.MethodPatch {
			var body map[string]any
			_ = json.NewDecoder(request.Body).Decode(&body)
			patches = append(patches, body)
			archived := ""
			if _, ok := body["time"]; ok {
				archived = `,"archived":1786673000000`
			}
			_, _ = w.Write([]byte(`{"id":"ses_abcdefgh","title":"Renamed","time":{"created":1786672800000,"updated":1786672900000` + archived + `}}`))
			return
		}
		if request.Method == http.MethodDelete {
			_, _ = w.Write([]byte(`true`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	ref := ports.AgentSessionRef{ID: "ses_abcdefgh"}
	if renamed, err := provider.RenameSession(context.Background(), domain.ActorContext{}, ref, "Renamed"); err != nil || renamed.Title != "Renamed" {
		t.Fatalf("renamed = %#v, err = %v", renamed, err)
	}
	if archived, err := provider.ArchiveSession(context.Background(), domain.ActorContext{}, ref); err != nil || archived.Status != domain.SessionArchived {
		t.Fatalf("archived = %#v, err = %v", archived, err)
	}
	if _, err := provider.UnarchiveSession(context.Background(), domain.ActorContext{}, ref); err == nil {
		t.Fatal("unarchive capability gap must be explicit")
	} else {
		var appErr *domain.AppError
		if !errors.As(err, &appErr) || appErr.Code != domain.ErrorCapabilityUnavailable {
			t.Fatalf("error = %#v", err)
		}
	}
	if err := provider.DeleteSession(context.Background(), domain.ActorContext{}, ref); err != nil {
		t.Fatal(err)
	}
	if len(patches) != 2 || patches[0]["title"] != "Renamed" || patches[1]["time"] == nil {
		t.Fatalf("patches = %#v", patches)
	}
}

func TestProviderStreamsDurableTurnEventsAndVerifiesCancellationOwnership(t *testing.T) {
	t.Parallel()
	var messageID string
	provider, _ := newOpenCodeProvider(t, http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch {
		case request.Method == http.MethodPost && request.URL.Path == "/api/session/ses_abcdefgh/prompt":
			var body struct {
				ID string `json:"id"`
			}
			_ = json.NewDecoder(request.Body).Decode(&body)
			messageID = body.ID
			_, _ = w.Write([]byte(`{"data":{"admittedSeq":7,"id":"` + messageID + `","sessionID":"ses_abcdefgh","prompt":{"text":"check"},"delivery":"queue","timeCreated":1}}`))
		case request.Method == http.MethodGet && request.URL.Path == "/api/session/ses_abcdefgh/event":
			if request.URL.Query().Get("after") != "7" {
				t.Errorf("after = %q", request.URL.Query().Get("after"))
			}
			w.Header().Set("Content-Type", "text/event-stream")
			frames := []string{
				`{"id":"evt_text0001","type":"session.next.text.ended","durable":{"aggregateID":"ses_abcdefgh","seq":8,"version":1},"data":{"timestamp":1786673000000,"sessionID":"ses_abcdefgh","assistantMessageID":"msg_assistant","textID":"text-1","text":"healthy"}}`,
				`{"id":"evt_tool0001","type":"session.next.tool.called","durable":{"aggregateID":"ses_abcdefgh","seq":9,"version":1},"data":{"timestamp":1786673000100,"sessionID":"ses_abcdefgh","assistantMessageID":"msg_assistant","callID":"provider-call","tool":"query_metrics","input":{"expr":"up"},"provider":{"executed":true}}}`,
				`{"id":"evt_tool0002","type":"session.next.tool.success","durable":{"aggregateID":"ses_abcdefgh","seq":10,"version":1},"data":{"timestamp":1786673000200,"sessionID":"ses_abcdefgh","assistantMessageID":"msg_assistant","callID":"provider-call","structured":{},"content":[],"provider":{"executed":true}}}`,
				`{"id":"evt_step0001","type":"session.next.step.ended","durable":{"aggregateID":"ses_abcdefgh","seq":11,"version":1},"data":{"timestamp":1786673000300,"sessionID":"ses_abcdefgh","assistantMessageID":"msg_assistant","finish":"stop","cost":0,"tokens":{"input":1,"output":1,"reasoning":0,"cache":{"read":0,"write":0}}}}`,
			}
			for _, frame := range frames {
				_, _ = w.Write([]byte("data: " + frame + "\n\n"))
			}
		case request.Method == http.MethodGet && request.URL.Path == "/api/session/ses_abcdefgh/message":
			_, _ = w.Write([]byte(`{"data":[{"id":"` + messageID + `","type":"user","time":{"created":1},"text":"check"}],"cursor":{}}`))
		case request.Method == http.MethodPost && request.URL.Path == "/api/session/ses_abcdefgh/interrupt":
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Errorf("unexpected request: %s %s", request.Method, request.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	actor := domain.ActorContext{TenantID: "tenant", OrgID: "org", UserID: "user"}
	turn, stream, err := provider.StartTurn(context.Background(), actor, ports.AgentSessionRef{ID: "ses_abcdefgh"}, ports.StartTurnInput{Message: "check", OperationID: "turn-operation-1"})
	if err != nil || !turn.ID.Valid() || messageID != "msg_"+strings.TrimPrefix(string(turn.ID), "turn_") {
		t.Fatalf("turn = %#v, message = %q, err = %v", turn, messageID, err)
	}
	defer stream.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	want := []domain.EventType{domain.EventMessageDelta, domain.EventToolStarted, domain.EventToolCompleted, domain.EventTurnCompleted}
	for sequence, eventType := range want {
		event, err := stream.Next(ctx)
		if err != nil || event.Type != eventType || event.Sequence != int64(sequence+1) || event.SessionID != "ses_abcdefgh" || event.TurnID != turn.ID || !event.ID.Valid() {
			t.Fatalf("event %d = %#v, err = %v", sequence, event, err)
		}
		if strings.Contains(string(event.ID), "evt_") && string(event.ID) == "evt_text0001" {
			t.Fatalf("provider event ID leaked: %q", event.ID)
		}
	}
	if _, err := stream.Next(ctx); !errors.Is(err, io.EOF) {
		t.Fatalf("stream after terminal event = %v, want EOF", err)
	}
	if err := provider.CancelTurn(context.Background(), actor, ports.AgentSessionRef{ID: "ses_abcdefgh"}, turn); err != nil {
		t.Fatal(err)
	}
}

func TestProviderRejectsCancellationForTurnOutsideSession(t *testing.T) {
	t.Parallel()
	provider, _ := newOpenCodeProvider(t, http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/api/session/ses_abcdefgh/message" {
			_, _ = w.Write([]byte(`{"data":[],"cursor":{}}`))
			return
		}
		t.Errorf("unexpected request: %s %s", request.Method, request.URL.Path)
	}))
	err := provider.CancelTurn(context.Background(), domain.ActorContext{}, ports.AgentSessionRef{ID: "ses_abcdefgh"}, ports.AgentTurnRef{ID: "turn_abcdefgh"})
	var appErr *domain.AppError
	if !errors.As(err, &appErr) || appErr.Code != domain.ErrorNotFound || appErr.Retryable {
		t.Fatalf("error = %#v", err)
	}
}

func TestProviderProjectsV1GlobalEventsForCurrentSession(t *testing.T) {
	t.Parallel()
	frames := []string{
		`{"id":"evt_other","type":"message.updated","properties":{"sessionID":"ses_other","info":{"role":"assistant","id":"msg_other","parentID":"msg_v1"}}}`,
		`{"id":"evt_assistant","type":"message.updated","properties":{"sessionID":"ses_abcdefgh","info":{"role":"assistant","id":"msg_assistant","parentID":"msg_v1","sessionID":"ses_abcdefgh"}}}`,
		`{"id":"evt_pending","type":"message.part.updated","properties":{"sessionID":"ses_abcdefgh","part":{"type":"tool","tool":"grafana-read_query_prometheus","callID":"provider-call","messageID":"msg_assistant","state":{"status":"pending","input":{}}}}}`,
		`{"id":"evt_running","type":"message.part.updated","properties":{"sessionID":"ses_abcdefgh","part":{"type":"tool","tool":"grafana-read_query_prometheus","callID":"provider-call","messageID":"msg_assistant","state":{"status":"running","input":{"expr":"up"}}}}}`,
		`{"id":"evt_completed","type":"message.part.updated","properties":{"sessionID":"ses_abcdefgh","part":{"type":"tool","tool":"grafana-read_query_prometheus","callID":"provider-call","messageID":"msg_assistant","state":{"status":"completed","input":{"expr":"up"},"output":"ok"}}}}`,
		`{"id":"evt_delta","type":"message.part.delta","properties":{"sessionID":"ses_abcdefgh","messageID":"msg_assistant","partID":"prt_text","field":"text","delta":"healthy"}}`,
		`{"id":"evt_stop","type":"message.part.updated","properties":{"sessionID":"ses_abcdefgh","part":{"type":"step-finish","reason":"stop","messageID":"msg_assistant"}}}`,
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		for _, frame := range frames {
			_, _ = w.Write([]byte("data: " + frame + "\n\n"))
		}
	}))
	defer server.Close()
	response, err := server.Client().Get(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	codec, _ := agentid.New([]byte("0123456789abcdef0123456789abcdef"))
	stream := newOpenCodeV1EventStream(response.Body, codec, "ses_abcdefgh", "turn_abcdefgh", "msg_v1")
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	want := []domain.EventType{domain.EventToolStarted, domain.EventToolCompleted, domain.EventMessageDelta, domain.EventTurnCompleted}
	for sequence, eventType := range want {
		event, err := stream.Next(ctx)
		if err != nil || event.Type != eventType || event.Sequence != int64(sequence+1) || event.SessionID != "ses_abcdefgh" || event.TurnID != "turn_abcdefgh" {
			t.Fatalf("event %d = %#v, err = %v", sequence, event, err)
		}
		if event.Type == domain.EventToolStarted && strings.Contains(string(event.Payload), "provider-call") {
			t.Fatalf("provider call ID leaked: %s", event.Payload)
		}
	}
	if _, err := stream.Next(ctx); !errors.Is(err, io.EOF) {
		t.Fatalf("stream after terminal event = %v", err)
	}
}
