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
		if body["dagName"] != "pbk_example.yaml" || body["dagRunId"] != "run_example" || body["params"] != `{"service":"api"}` {
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

func TestClientUsesRotatingBasicAuth(t *testing.T) {
	t.Parallel()
	password := "first"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		username, provided, ok := request.BasicAuth()
		if !ok || username != "aegis" || provided != password {
			t.Errorf("basic auth = %q %q %v", username, provided, ok)
		}
		_, _ = w.Write([]byte(`{"dags":[],"pagination":{"currentPage":1,"perPage":1,"totalPages":0}}`))
	}))
	defer server.Close()
	client, err := NewClient(server.URL, server.Client(), WithBasicAuthSource(func() (string, string, error) {
		return "aegis", password, nil
	}))
	if err != nil {
		t.Fatal(err)
	}
	for _, next := range []string{"first", "rotated"} {
		password = next
		if _, err := client.ListDAGs(context.Background(), 1, 1); err != nil {
			t.Fatal(err)
		}
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

func TestClientListsRunsForOneDAG(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/api/v1/dag-runs" || request.URL.Query().Get("name") != "pbk_a" || request.URL.Query().Get("limit") != "11" {
			t.Errorf("request = %s?%s", request.URL.Path, request.URL.RawQuery)
		}
		_, _ = w.Write([]byte(`{"dagRuns":[{"dagRunId":"run_a","name":"pbk_a","statusLabel":"running"}]}`))
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, server.Client())
	runs, err := client.ListRuns(context.Background(), "pbk_a", 11)
	if err != nil || len(runs) != 1 || runs[0].DAGRunID != "run_a" {
		t.Fatalf("runs = %#v, err = %v", runs, err)
	}
}

func TestClientPreservesDAGPagination(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Query().Get("page") != "2" || request.URL.Query().Get("perPage") != "25" {
			t.Errorf("query = %q", request.URL.RawQuery)
		}
		_, _ = w.Write([]byte(`{"dags":[{"fileName":"pbk_scope_abcdefgh"}],"pagination":{"currentPage":2,"perPage":25,"totalPages":4}}`))
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, server.Client())
	page, err := client.ListDAGs(context.Background(), 2, 25)
	if err != nil || len(page.DAGs) != 1 || page.Page != 2 || page.TotalPages != 4 {
		t.Fatalf("page = %#v, err = %v", page, err)
	}
}
