package dagu

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/1024XEngineer/aegis-sre/internal/domain"
	"github.com/1024XEngineer/aegis-sre/internal/ports"
)

func TestProviderUsesPublicIDsWithoutMappingStore(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/api/v1/dags/pbk_abcdefgh/start":
			var body map[string]any
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if body["dagName"] != "pbk_abcdefgh" {
				t.Errorf("dagName = %#v", body["dagName"])
			}
			_, _ = w.Write([]byte(`{"dagRunId":"run_abcdefgh"}`))
		case "/api/v1/dag-runs/pbk_abcdefgh/run_abcdefgh":
			_, _ = w.Write([]byte(`{"dagRunDetails":{"dagRunId":"run_abcdefgh","name":"pbk_abcdefgh","statusLabel":"success","nodes":[]}}`))
		default:
			t.Errorf("unexpected path %q", request.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, server.Client())
	provider, _ := NewProvider(client)
	ref := ports.PlaybookRef{ID: "pbk_abcdefgh"}
	runRef, err := provider.StartRun(context.Background(), domain.ActorContext{}, ref, ports.RunPlaybookInput{ID: "run_abcdefgh", Parameters: map[string]string{}})
	if err != nil {
		t.Fatal(err)
	}
	state, err := provider.GetRun(context.Background(), domain.ActorContext{}, runRef)
	if err != nil || state.Status != domain.RunSucceeded || state.Ref != runRef {
		t.Fatalf("state = %#v, err = %v", state, err)
	}
}

func TestProviderFiltersNonAegisDAGs(t *testing.T) {
	t.Parallel()
	actor := domain.ActorContext{TenantID: "tenant", OrgID: "org", UserID: "user"}
	id := "pbk_" + domain.PlaybookScopeKey(actor) + "_abcdefgh"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"dags":[{"fileName":"` + id + `","dag":{"name":"safe"}},{"fileName":"foreign.yaml","dag":{"name":"foreign"}}],"pagination":{"currentPage":1,"perPage":10,"totalPages":1}}`))
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, server.Client())
	provider, _ := NewProvider(client)
	page, err := provider.List(context.Background(), actor, domain.PageRequest{Limit: 10})
	if err != nil || len(page.Items) != 1 || page.Items[0].Ref.ID != domain.ID(id) {
		t.Fatalf("page = %#v, err = %v", page, err)
	}
}

func TestProviderRejectsInvalidIDsAndArtifactTraversalBeforeCallingDagu(t *testing.T) {
	t.Parallel()
	called := false
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
	defer server.Close()
	client, _ := NewClient(server.URL, server.Client())
	provider, _ := NewProvider(client)
	_, err := provider.StartRun(context.Background(), domain.ActorContext{}, ports.PlaybookRef{ID: "provider_internal"}, ports.RunPlaybookInput{ID: "run_abcdefgh"})
	if err == nil {
		t.Fatal("expected invalid playbook ID")
	}
	_, err = provider.PreviewArtifact(context.Background(), domain.ActorContext{}, ports.PlaybookRunRef{ID: "run_abcdefgh", PlaybookID: "pbk_abcdefgh"}, "../secret")
	if err == nil || !strings.Contains(err.Error(), "artifact") {
		t.Fatalf("error = %v", err)
	}
	if called {
		t.Fatal("Dagu must not be called for invalid public input")
	}
}

func TestMapRunDistinguishesDaguWaitingStates(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name       string
		step       string
		wantStatus domain.RunStatus
	}{
		{name: "human task", step: `"humanTask":{"prompt":"check"}`, wantStatus: domain.RunWaitingForInput},
		{name: "approval", step: `"approval":{"prompt":"approve"}`, wantStatus: domain.RunWaitingForApproval},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			run := DAGRun{StatusText: "waiting", Nodes: []byte(`[{"statusLabel":"waiting","step":{"id":"review","name":"Review",` + test.step + `}}]`)}
			state := mapRun(ports.PlaybookRunRef{ID: "run_abcdefgh", PlaybookID: "pbk_abcdefgh"}, run)
			if state.Status != test.wantStatus || len(state.Steps) != 1 || state.Steps[0].Status != test.wantStatus {
				t.Fatalf("state = %#v", state)
			}
		})
	}
}

func TestMapRunHandlesAllTerminalDaguStatuses(t *testing.T) {
	t.Parallel()
	tests := map[string]domain.RunStatus{
		"succeeded":           domain.RunSucceeded,
		"failed":              domain.RunFailed,
		"partially_succeeded": domain.RunFailed,
		"rejected":            domain.RunFailed,
		"aborted":             domain.RunCancelled,
	}
	for input, expected := range tests {
		if actual := mapRunStatus(input); actual != expected || !terminalRunStatus(actual) {
			t.Errorf("status %q = %q, terminal = %t", input, actual, terminalRunStatus(actual))
		}
	}
}

func TestProviderResolvesRunNameFromDaguWithoutMappingStore(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/api/v1/dag-runs":
			if request.URL.Query().Get("dagRunId") != "run_abcdefgh" {
				t.Errorf("query = %q", request.URL.RawQuery)
			}
			_, _ = w.Write([]byte(`{"dagRuns":[{"dagRunId":"run_abcdefgh","name":"pbk_abcdefgh","statusLabel":"running"}]}`))
		case "/api/v1/dag-runs/pbk_abcdefgh/run_abcdefgh":
			_, _ = w.Write([]byte(`{"dagRunDetails":{"dagRunId":"run_abcdefgh","name":"pbk_abcdefgh","statusLabel":"running"}}`))
		default:
			t.Errorf("path = %q", request.URL.Path)
		}
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, server.Client())
	provider, _ := NewProvider(client)
	state, err := provider.GetRun(context.Background(), domain.ActorContext{}, ports.PlaybookRunRef{ID: "run_abcdefgh"})
	if err != nil || state.Ref.PlaybookID != "pbk_abcdefgh" {
		t.Fatalf("state = %#v, err = %v", state, err)
	}
}

func TestProviderListsOnlyPublicRunsForRequestedPlaybook(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Query().Get("name") != "pbk_abcdefgh" || request.URL.Query().Get("limit") != "3" {
			t.Errorf("query = %q", request.URL.RawQuery)
		}
		_, _ = w.Write([]byte(`{"dagRuns":[
			{"dagRunId":"run_first123","name":"pbk_abcdefgh","statusLabel":"success"},
			{"dagRunId":"internal","name":"pbk_abcdefgh","statusLabel":"running"},
			{"dagRunId":"run_foreign","name":"pbk_foreign","statusLabel":"failed"}
		]}`))
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, server.Client())
	provider, _ := NewProvider(client)
	page, err := provider.ListRuns(context.Background(), domain.ActorContext{}, ports.PlaybookRef{ID: "pbk_abcdefgh"}, domain.PageRequest{Limit: 2})
	if err != nil || len(page.Items) != 1 || page.Items[0].Ref.ID != "run_first123" || page.Items[0].Status != domain.RunSucceeded || page.HasMore {
		t.Fatalf("page = %#v, err = %v", page, err)
	}
}

func TestProviderPaginatesRunsWithOpaqueCursor(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		_, _ = w.Write([]byte(`{"dagRuns":[
			{"dagRunId":"run_first123","name":"pbk_abcdefgh","statusLabel":"success"},
			{"dagRunId":"run_second12","name":"pbk_abcdefgh","statusLabel":"failed"},
			{"dagRunId":"run_third123","name":"pbk_abcdefgh","statusLabel":"running"}
		]}`))
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, server.Client())
	provider, _ := NewProvider(client)
	first, err := provider.ListRuns(context.Background(), domain.ActorContext{}, ports.PlaybookRef{ID: "pbk_abcdefgh"}, domain.PageRequest{Limit: 2})
	if err != nil || len(first.Items) != 2 || !first.HasMore || first.NextCursor == "" {
		t.Fatalf("first page = %#v, err = %v", first, err)
	}
	second, err := provider.ListRuns(context.Background(), domain.ActorContext{}, ports.PlaybookRef{ID: "pbk_abcdefgh"}, domain.PageRequest{Limit: 2, Cursor: first.NextCursor})
	if err != nil || len(second.Items) != 1 || second.Items[0].Ref.ID != "run_third123" || second.HasMore || second.NextCursor != "" {
		t.Fatalf("second page = %#v, err = %v", second, err)
	}
}

func TestProviderRecoversIdempotentCreateConflict(t *testing.T) {
	t.Parallel()
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		requests++
		switch request.Method + " " + request.URL.Path {
		case "POST /api/v1/dags":
			w.WriteHeader(http.StatusConflict)
		case "GET /api/v1/dags/pbk_abcdefgh":
			_, _ = w.Write([]byte(`{"spec":"steps: []"}`))
		default:
			t.Errorf("request = %s %s", request.Method, request.URL.Path)
		}
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, server.Client())
	provider, _ := NewProvider(client)
	ref, err := provider.Create(context.Background(), domain.ActorContext{}, ports.CreatePlaybookInput{ID: "pbk_abcdefgh", YAML: []byte("steps: []")})
	if err != nil || ref.ID != "pbk_abcdefgh" || requests != 2 {
		t.Fatalf("ref = %#v, requests = %d, err = %v", ref, requests, err)
	}
}

func TestProviderRejectsCreateConflictWithDifferentSource(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.Method == http.MethodPost {
			w.WriteHeader(http.StatusConflict)
			return
		}
		_, _ = w.Write([]byte(`{"spec":"name: other\nsteps: []\n"}`))
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, server.Client())
	provider, _ := NewProvider(client)
	_, err := provider.Create(context.Background(), domain.ActorContext{}, ports.CreatePlaybookInput{ID: "pbk_abcdefgh", YAML: []byte("name: requested\nsteps: []\n")})
	var httpErr *HTTPError
	if !errors.As(err, &httpErr) || httpErr.StatusCode != http.StatusConflict {
		t.Fatalf("error = %#v", err)
	}
}

func TestProviderGetsNameAndDescriptionFromNativeYAML(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"spec":"name: diagnose\ndescription: Diagnose service\nsteps: []\n"}`))
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, server.Client())
	provider, _ := NewProvider(client)
	resource, err := provider.Get(context.Background(), domain.ActorContext{}, ports.PlaybookRef{ID: "pbk_abcdefgh"})
	if err != nil || resource.Name != "diagnose" || resource.Description != "Diagnose service" {
		t.Fatalf("resource = %#v, err = %v", resource, err)
	}
}

func TestProviderRecoversIdempotentRunConflicts(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch request.Method + " " + request.URL.Path {
		case "POST /api/v1/dags/pbk_abcdefgh/start",
			"POST /api/v1/dag-runs/pbk_abcdefgh/run_original/retry":
			w.WriteHeader(http.StatusConflict)
		case "GET /api/v1/dag-runs/pbk_abcdefgh/run_abcdefgh":
			_, _ = w.Write([]byte(`{"dagRunDetails":{"dagRunId":"run_abcdefgh","name":"pbk_abcdefgh"}}`))
		default:
			t.Errorf("request = %s %s", request.Method, request.URL.Path)
		}
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, server.Client())
	provider, _ := NewProvider(client)

	started, err := provider.StartRun(context.Background(), domain.ActorContext{}, ports.PlaybookRef{ID: "pbk_abcdefgh"}, ports.RunPlaybookInput{ID: "run_abcdefgh"})
	if err != nil || started.ID != "run_abcdefgh" {
		t.Fatalf("started = %#v, err = %v", started, err)
	}
	retried, err := provider.RetryRun(context.Background(), domain.ActorContext{}, ports.PlaybookRunRef{ID: "run_original", PlaybookID: "pbk_abcdefgh"}, "run_abcdefgh")
	if err != nil || retried.ID != "run_abcdefgh" {
		t.Fatalf("retried = %#v, err = %v", retried, err)
	}
}

func TestProviderDoesNotHideUnverifiedConflict(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.Method == http.MethodPost {
			w.WriteHeader(http.StatusConflict)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, server.Client())
	provider, _ := NewProvider(client)
	_, err := provider.StartRun(context.Background(), domain.ActorContext{}, ports.PlaybookRef{ID: "pbk_abcdefgh"}, ports.RunPlaybookInput{ID: "run_abcdefgh"})
	var httpErr *HTTPError
	if !errors.As(err, &httpErr) || httpErr.StatusCode != http.StatusConflict {
		t.Fatalf("error = %#v", err)
	}
}
