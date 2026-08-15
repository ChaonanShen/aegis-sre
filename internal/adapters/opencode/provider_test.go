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
		case "/session":
			_, _ = w.Write([]byte(`[{"id":"ses_active123","title":"Active","time":{"created":1786672800000,"updated":1786672900000}},{"id":"ses_archive1","title":"Archived","time":{"created":1786672800000,"updated":1786672900000,"archived":1786673000000}}]`))
		case "/session/ses_archive1":
			_, _ = w.Write([]byte(`{"id":"ses_archive1","title":"Archived","time":{"created":1786672800000,"updated":1786672900000,"archived":1786673000000}}`))
		case "/session/ses_archive1/message":
			_, _ = w.Write([]byte(`[{"info":{"id":"msg_user","role":"user","time":{"created":1786672810000}},"parts":[{"type":"text","text":"check"}]},{"info":{"id":"msg_assistant","role":"assistant","time":{"created":1786672820000}},"parts":[{"type":"text","text":"done"}]}]`))
		default:
			t.Errorf("unexpected path: %s", request.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	page, err := provider.ListSessions(context.Background(), domain.ActorContext{}, ports.ListAgentSessionsInput{Page: domain.PageRequest{Limit: 50}, Status: domain.SessionArchived})
	if err != nil || len(page.Items) != 1 || page.Items[0].Ref.ID != "ses_archive1" || page.HasMore {
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
	promptDone := make(chan struct{})
	provider, _ := newOpenCodeProvider(t, http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch {
		case request.Method == http.MethodGet && request.URL.Path == "/config":
			_, _ = w.Write([]byte(`{"model":"deepseek/deepseek-chat"}`))
		case request.Method == http.MethodPost && request.URL.Path == "/session/ses_abcdefgh/prompt_async":
			var body struct {
				MessageID string `json:"messageID"`
			}
			_ = json.NewDecoder(request.Body).Decode(&body)
			messageID = body.MessageID
			close(promptDone)
			w.WriteHeader(http.StatusNoContent)
		case request.Method == http.MethodGet && request.URL.Path == "/event":
			w.Header().Set("Content-Type", "text/event-stream")
			if flusher, ok := w.(http.Flusher); ok {
				w.WriteHeader(http.StatusOK)
				flusher.Flush()
			}
			select {
			case <-promptDone:
			case <-request.Context().Done():
				return
			}
			frames := []string{
				`{"id":"evt_assistant","type":"message.updated","properties":{"sessionID":"ses_abcdefgh","info":{"role":"assistant","id":"msg_assistant","parentID":"` + messageID + `"}}}`,
				`{"id":"evt_tool1","type":"message.part.updated","properties":{"sessionID":"ses_abcdefgh","part":{"type":"tool","tool":"query_metrics","callID":"provider-call","messageID":"msg_assistant","state":{"status":"pending","input":{"expr":"up"}}}}}`,
				`{"id":"evt_tool2","type":"message.part.updated","properties":{"sessionID":"ses_abcdefgh","part":{"type":"tool","tool":"query_metrics","callID":"provider-call","messageID":"msg_assistant","state":{"status":"completed","input":{"expr":"up"}}}}}`,
				`{"id":"evt_delta","type":"message.part.delta","properties":{"sessionID":"ses_abcdefgh","messageID":"msg_assistant","partID":"prt_text","field":"text","delta":"healthy"}}`,
				`{"id":"evt_step","type":"message.part.updated","properties":{"sessionID":"ses_abcdefgh","part":{"type":"step-finish","reason":"stop","messageID":"msg_assistant"}}}`,
			}
			for _, frame := range frames {
				_, _ = w.Write([]byte("data: " + frame + "\n\n"))
			}
		case request.Method == http.MethodGet && request.URL.Path == "/session/ses_abcdefgh/message":
			_, _ = w.Write([]byte(`[{"info":{"id":"` + messageID + `","role":"user","time":{"created":1}},"parts":[{"type":"text","text":"check"}]}]`))
		case request.Method == http.MethodPost && request.URL.Path == "/session/ses_abcdefgh/abort":
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
	want := []domain.EventType{domain.EventToolStarted, domain.EventToolCompleted, domain.EventMessageDelta, domain.EventTurnCompleted}
	for sequence, eventType := range want {
		event, err := stream.Next(ctx)
		if err != nil || event.Type != eventType || event.Sequence != int64(sequence+1) || event.SessionID != "ses_abcdefgh" || event.TurnID != turn.ID || !event.ID.Valid() {
			t.Fatalf("event %d = %#v, err = %v", sequence, event, err)
		}
		if strings.Contains(string(event.ID), "evt_") && string(event.ID) == "evt_text0001" {
			t.Fatalf("provider event ID leaked: %q", event.ID)
		}
		if event.Type == domain.EventToolCompleted && !strings.Contains(string(event.Payload), `"duration_ms":null`) {
			t.Fatalf("missing duration must remain null: %s", event.Payload)
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
		if request.URL.Path == "/session/ses_abcdefgh/message" {
			_, _ = w.Write([]byte(`[]`))
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

func TestOpenCodeV1RejectsForeignNestedOwnershipAndRequiresOwnershipEvidence(t *testing.T) {
	t.Parallel()
	frames := []string{
		`{"id":"evt_other_assistant","type":"message.updated","properties":{"info":{"role":"assistant","id":"msg_other","parentID":"msg_v1","sessionID":"ses_other"}}}`,
		`{"id":"evt_assistant","type":"message.updated","properties":{"info":{"role":"assistant","id":"msg_assistant","parentID":"msg_v1","sessionID":"ses_abcdefgh"}}}`,
		`{"id":"evt_other_tool","type":"message.part.updated","properties":{"part":{"type":"tool","tool":"read","callID":"foreign-call","messageID":"msg_assistant","sessionID":"ses_other","state":{"status":"pending","input":{"path":"/other"}}}}}`,
		`{"id":"evt_current_tool","type":"message.part.updated","properties":{"part":{"type":"tool","tool":"read","callID":"current-call","messageID":"msg_assistant","state":{"status":"pending","input":{"path":"/current"}}}}}`,
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
	if event, err := stream.Next(ctx); err != nil || event.Type != domain.EventToolStarted || !strings.Contains(string(event.Payload), "/current") || strings.Contains(string(event.Payload), "/other") {
		t.Fatalf("event = %#v, err = %v", event, err)
	}
	if event, err := stream.Next(ctx); err != nil || event.Type != domain.EventTurnCompleted {
		t.Fatalf("terminal event = %#v, err = %v", event, err)
	}
}
