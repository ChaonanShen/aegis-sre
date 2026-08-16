package raglite

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestClientSendsAuthenticationScopeAndUploadMetadata(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer provider-secret" {
			t.Fatal("missing provider authentication")
		}
		if request.Header.Get("X-Aegis-Scope") != "scp_abcdefgh" {
			t.Fatal("missing scope header")
		}
		if err := request.ParseMultipartForm(1 << 20); err != nil {
			t.Fatal(err)
		}
		if request.FormValue("id") != "doc_abcdefgh" || request.FormValue("service") != "checkout" || request.FormValue("tags") != `["prod"]` {
			t.Fatalf("unexpected upload metadata: %v", request.Form)
		}
		file, header, err := request.FormFile("file")
		if err != nil {
			t.Fatal(err)
		}
		defer file.Close()
		body, _ := io.ReadAll(file)
		if header.Filename != "runbook.md" || string(body) != "hello" {
			t.Fatalf("unexpected uploaded file %q %q", header.Filename, body)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"doc_abcdefgh","collection_id":"kbs_abcdefgh","name":"runbook.md","media_type":"text/markdown","size":5,"sha256":"digest","service":"checkout","tags":["prod"],"status":"queued","created_at":"2026-08-15T00:00:00Z","updated_at":"2026-08-15T00:00:00Z"}`)
	}))
	defer server.Close()
	client, err := NewClient(server.URL, func() (string, error) { return "provider-secret", nil }, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	document, err := client.UploadDocument(context.Background(), "scp_abcdefgh", "kbs_abcdefgh", "doc_abcdefgh", "runbook.md", "text/markdown", "checkout", []string{"prod"}, strings.NewReader("hello"))
	if err != nil {
		t.Fatal(err)
	}
	if document.ID != "doc_abcdefgh" || document.Size != 5 {
		t.Fatalf("unexpected response: %+v", document)
	}
}

func TestClientMapsStableProblemWithoutLeakingBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnprocessableEntity)
		_, _ = io.WriteString(w, `{"code":"capability_unavailable","message":"secret backend detail","retryable":false}`)
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, func() (string, error) { return "token", nil }, server.Client())
	_, err := client.Search(context.Background(), "scp_abcdefgh", "query", []string{"kbs_abcdefgh"}, "", 5, 0.2)
	providerErr, ok := err.(*ProviderError)
	if !ok || providerErr.Code != "capability_unavailable" || strings.Contains(providerErr.Error(), "secret") {
		t.Fatalf("unexpected provider error: %#v", err)
	}
}

func TestClientRejectsOversizedResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.CopyN(w, strings.NewReader(strings.Repeat("x", maxResponseBytes+1)), maxResponseBytes+1)
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, func() (string, error) { return "token", nil }, server.Client())
	err := client.Check(context.Background())
	if err == nil {
		t.Fatal("oversized provider response must fail")
	}
}
