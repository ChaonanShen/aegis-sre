package opencode

import (
	"context"
	"encoding/base64"
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
		_, _ = w.Write([]byte(`{"data":{"id":"ses_abcdefgh","title":"diagnose"}}`))
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, server.Client(), "aegis", func() (string, error) { return password, nil })
	for _, next := range []string{"first", "rotated"} {
		password = next
		session, err := client.CreateSession(context.Background(), "ses_abcdefgh", "diagnose")
		if err != nil || session.ID != "ses_abcdefgh" {
			t.Fatalf("session = %#v, err = %v", session, err)
		}
	}
	if requests != 2 {
		t.Fatalf("requests = %d", requests)
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

func TestClientMapsPromptAbortAndPermissionEndpoints(t *testing.T) {
	t.Parallel()
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		paths = append(paths, request.URL.Path)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, server.Client(), "", nil)
	ctx := context.Background()
	if err := client.PromptAsync(ctx, "ses_abcdefgh", "msg_abcdefgh", "hello"); err != nil {
		t.Fatal(err)
	}
	if err := client.Abort(ctx, "ses_abcdefgh"); err != nil {
		t.Fatal(err)
	}
	if err := client.ResolvePermission(ctx, "ses_abcdefgh", "apr_abcdefgh", "once"); err != nil {
		t.Fatal(err)
	}
	want := []string{"/session/ses_abcdefgh/prompt_async", "/session/ses_abcdefgh/abort", "/session/ses_abcdefgh/permissions/apr_abcdefgh"}
	if strings.Join(paths, ",") != strings.Join(want, ",") {
		t.Fatalf("paths = %#v", paths)
	}
}
