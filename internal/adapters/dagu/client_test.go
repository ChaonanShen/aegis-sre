package dagu

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestClientUsesCallerSuppliedRunIDAndRotatingToken(t *testing.T) {
	t.Parallel()
	token := "first"
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		requests++
		if request.URL.Path != "/api/v1/dags/pbk_example.yaml/start" {
			t.Errorf("path = %q", request.URL.Path)
		}
		if got := request.Header.Get("Authorization"); got != "Bearer "+token {
			t.Errorf("authorization = %q", got)
		}
		var body map[string]any
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["dagRunId"] != "run_example" || body["params"] != `{"service":"api"}` {
			t.Errorf("body = %#v", body)
		}
		_, _ = w.Write([]byte(`{"dagRunId":"run_example"}`))
	}))
	defer server.Close()

	client, err := NewClient(server.URL, server.Client(), WithTokenSource(func() (string, error) { return token, nil }))
	if err != nil {
		t.Fatal(err)
	}
	for _, expectedToken := range []string{"first", "rotated"} {
		token = expectedToken
		runID, err := client.StartDAG(context.Background(), "pbk_example.yaml", "run_example", map[string]string{"service": "api"}, false)
		if err != nil || runID != "run_example" {
			t.Fatalf("runID = %q, err = %v", runID, err)
		}
	}
	if requests != 2 {
		t.Fatalf("requests = %d", requests)
	}
}

func TestClientEncodesArtifactPathAndProviderIdentifiers(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/v1/dag-runs/pbk_a/run_a/artifacts/preview" {
			t.Errorf("path = %q", request.URL.Path)
		}
		if request.URL.Query().Get("path") != "reports/诊断 report.md" {
			t.Errorf("artifact path = %q", request.URL.Query().Get("path"))
		}
		_, _ = w.Write([]byte(`{"path":"reports/诊断 report.md","content":"ok","mimeType":"text/markdown"}`))
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, server.Client())
	preview, err := client.PreviewArtifact(context.Background(), "pbk_a", "run_a", "reports/诊断 report.md")
	if err != nil || preview.Content != "ok" {
		t.Fatalf("preview = %#v, err = %v", preview, err)
	}
}

func TestClientSanitizesErrorsAndLimitsResponses(t *testing.T) {
	t.Parallel()
	t.Run("provider body is not exposed", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write([]byte(`secret provider detail`))
		}))
		defer server.Close()
		client, _ := NewClient(server.URL, server.Client())
		_, err := client.GetDAG(context.Background(), "pbk_a.yaml")
		var httpErr *HTTPError
		if !errors.As(err, &httpErr) || !httpErr.Retryable || strings.Contains(err.Error(), "secret") {
			t.Fatalf("error = %#v", err)
		}
	})

	t.Run("oversized success is rejected", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{"spec":"too large"}`))
		}))
		defer server.Close()
		client, _ := NewClient(server.URL, server.Client(), WithMaxResponseBytes(8))
		_, err := client.GetDAG(context.Background(), "pbk_a.yaml")
		if err == nil || !strings.Contains(err.Error(), "exceeds") {
			t.Fatalf("error = %v", err)
		}
	})
}

func TestResolveApprovalMapsRewindToPushBack(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/api/v1/dag-runs/pbk_a/run_a/steps/review/push-back" {
			t.Errorf("request = %s %s", request.Method, request.URL.Path)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, server.Client())
	if err := client.ResolveApproval(context.Background(), "pbk_a", "run_a", "review", "rewind", nil); err != nil {
		t.Fatal(err)
	}
}
