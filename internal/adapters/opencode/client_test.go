package opencode

import (
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestClientUsesCallerSessionIDAndRotatingBasicAuth(t *testing.T) {
	t.Parallel()
	password := "first"
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		requests++
		if got := request.Header.Get("Authorization"); got != "Basic "+base64.StdEncoding.EncodeToString([]byte("aegis:"+password)) {
			t.Errorf("authorization = %q", got)
		}
		if request.URL.Path != "/api/session" {
			t.Errorf("path = %q", request.URL.Path)
		}
		_, _ = w.Write([]byte(`{"data":{"id":"ses_abcdefgh","title":"diagnose","time":{"created":1,"updated":1}}}`))
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, server.Client(), "aegis", func() (string, error) { return password, nil })
	for _, next := range []string{"first", "rotated"} {
		password = next
		session, err := client.CreateSession(context.Background(), "ses_abcdefgh")
		if err != nil || session.ID != "ses_abcdefgh" {
			t.Fatalf("session = %#v, err = %v", session, err)
		}
	}
	if requests != 2 {
		t.Fatalf("requests = %d", requests)
	}
}

func TestClientListsProjectedMessagesAndSubscribesDurableEvents(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/api/session/ses_abcdefgh/message":
			if request.URL.Query().Get("order") != "asc" || request.URL.Query().Get("limit") != "200" {
				t.Errorf("message query = %s", request.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`{"data":[{"id":"msg_abcdefgh","type":"user","time":{"created":1},"text":"hello"}],"cursor":{"next":"messages-next"}}`))
		case "/api/session/ses_abcdefgh/event":
			if request.URL.Query().Get("after") != "7" || request.Header.Get("Accept") != "text/event-stream" {
				t.Errorf("event request = %s, headers = %v", request.URL.String(), request.Header)
			}
			w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
			_, _ = w.Write([]byte("id: 8\nevent: session.next.text.ended\ndata: {}\n\n"))
		default:
			t.Errorf("path = %q", request.URL.Path)
		}
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, server.Client(), "", nil)
	messages, next, err := client.ListMessages(context.Background(), "ses_abcdefgh", "", 200)
	if err != nil || len(messages) != 1 || messages[0].Text != "hello" || next != "messages-next" {
		t.Fatalf("messages = %#v, next = %q, err = %v", messages, next, err)
	}
	stream, err := client.SubscribeEvents(context.Background(), "ses_abcdefgh", "7")
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	content, _ := io.ReadAll(stream)
	if !strings.Contains(string(content), "session.next.text.ended") {
		t.Fatalf("events = %s", content)
	}
}

func TestClientSanitizesErrorsAndEncodesIDs(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.EscapedPath() != "/api/session/ses_%2Funsafe" {
			t.Errorf("path = %q", request.URL.EscapedPath())
		}
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte("provider secret"))
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, server.Client(), "", nil)
	_, err := client.GetSession(context.Background(), "ses_/unsafe")
	if err == nil || strings.Contains(err.Error(), "secret") {
		t.Fatalf("error = %v", err)
	}
}

func TestClientMapsV2PromptInterruptPermissionAndV1MutationEndpoints(t *testing.T) {
	t.Parallel()
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		paths = append(paths, request.URL.Path)
		if request.URL.Path == "/api/session/ses_abcdefgh/prompt" {
			_, _ = w.Write([]byte(`{"data":{"admittedSeq":7,"id":"msg_abcdefgh","sessionID":"ses_abcdefgh","prompt":{"text":"hello"},"delivery":"queue","timeCreated":1}}`))
			return
		}
		if request.Method == http.MethodPatch {
			_, _ = w.Write([]byte(`{"id":"ses_abcdefgh","title":"renamed","time":{"created":1,"updated":2}}`))
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, server.Client(), "", nil)
	ctx := context.Background()
	if admitted, err := client.Prompt(ctx, "ses_abcdefgh", "msg_abcdefgh", "hello"); err != nil || admitted.Sequence != 7 {
		t.Fatal(err)
	}
	if err := client.Interrupt(ctx, "ses_abcdefgh"); err != nil {
		t.Fatal(err)
	}
	if err := client.ResolvePermission(ctx, "ses_abcdefgh", "apr_abcdefgh", "once"); err != nil {
		t.Fatal(err)
	}
	if _, err := client.UpdateSession(ctx, "ses_abcdefgh", map[string]any{"title": "renamed"}); err != nil {
		t.Fatal(err)
	}
	if err := client.DeleteSession(ctx, "ses_abcdefgh"); err != nil {
		t.Fatal(err)
	}
	want := []string{"/api/session/ses_abcdefgh/prompt", "/api/session/ses_abcdefgh/interrupt", "/api/session/ses_abcdefgh/permission/apr_abcdefgh/reply", "/session/ses_abcdefgh", "/session/ses_abcdefgh"}
	if strings.Join(paths, ",") != strings.Join(want, ",") {
		t.Fatalf("paths = %#v", paths)
	}
}
