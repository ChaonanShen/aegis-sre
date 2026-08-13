package dagu

import (
	"context"
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
		case "/api/v1/dags/pbk_abcdefgh.yaml/start":
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
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"dags":[{"fileName":"pbk_abcdefgh.yaml","dag":{"name":"safe"}},{"fileName":"foreign.yaml","dag":{"name":"foreign"}}]}`))
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, server.Client())
	provider, _ := NewProvider(client)
	page, err := provider.List(context.Background(), domain.ActorContext{}, domain.PageRequest{Limit: 10})
	if err != nil || len(page.Items) != 1 || page.Items[0].Ref.ID != "pbk_abcdefgh" {
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

func TestMapRunPreservesHumanTaskAndApproval(t *testing.T) {
	t.Parallel()
	run := DAGRun{StatusText: "waiting", Nodes: []byte(`[{"statusLabel":"waiting","step":{"id":"review","name":"Review","humanTask":{"prompt":"check"},"approval":{"prompt":"approve"}}}]`)}
	state := mapRun(ports.PlaybookRunRef{ID: "run_abcdefgh", PlaybookID: "pbk_abcdefgh"}, run)
	if state.Status != domain.RunWaitingForApproval || len(state.Steps) != 1 || state.Steps[0].HumanTask["prompt"] != "check" || state.Steps[0].Approval["prompt"] != "approve" {
		t.Fatalf("state = %#v", state)
	}
}
