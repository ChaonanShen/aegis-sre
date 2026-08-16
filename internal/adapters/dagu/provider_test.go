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

func providerTestActor(folderUID string) domain.ActorContext {
	return domain.ActorContext{TenantID: "tenant", OrgID: "org", UserID: "user", FolderUID: folderUID}
}

func writeOwnedDAG(w http.ResponseWriter, folderUID, spec string) {
	bound, err := bindFolderOwnership([]byte(spec), folderUID)
	if err != nil {
		panic(err)
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"spec": string(bound)})
}

func TestProviderUsesYAMLNameForRunsAndStableLabelForOwnership(t *testing.T) {
	t.Parallel()
	label := playbookRunLabel("pbk_abcdefgh")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/api/v1/dags/pbk_abcdefgh":
			writeOwnedDAG(w, "folder-a", "name: diagnose-api\nsteps: []\n")
		case "/api/v1/dags/pbk_abcdefgh/start":
			var body map[string]any
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			labels, _ := body["labels"].([]any)
			if body["dagName"] != nil || len(labels) != 1 || labels[0] != label {
				t.Errorf("body = %#v", body)
			}
			_, _ = w.Write([]byte(`{"dagRunId":"run_abcdefgh"}`))
		case "/api/v1/dag-runs":
			_, _ = w.Write([]byte(`{"dagRuns":[{"dagRunId":"run_abcdefgh","name":"diagnose-api","labels":["` + label + `"],"statusLabel":"success"}]}`))
		case "/api/v1/dag-runs/diagnose-api/run_abcdefgh":
			_, _ = w.Write([]byte(`{"dagRunDetails":{"dagRunId":"run_abcdefgh","name":"diagnose-api","labels":["` + label + `"],"statusLabel":"success","nodes":[]}}`))
		default:
			t.Errorf("unexpected path %q", request.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, server.Client())
	provider, _ := NewProvider(client)
	ref := ports.PlaybookRef{ID: "pbk_abcdefgh"}
	actor := providerTestActor("folder-a")
	runRef, err := provider.StartRun(context.Background(), actor, ref, ports.RunPlaybookInput{ID: "run_abcdefgh", Parameters: map[string]string{}})
	if err != nil {
		t.Fatal(err)
	}
	state, err := provider.GetRun(context.Background(), actor, runRef)
	if err != nil || state.Status != domain.RunSucceeded || state.Ref != runRef {
		t.Fatalf("state = %#v, err = %v", state, err)
	}
}

func TestProviderFiltersNonAegisDAGs(t *testing.T) {
	t.Parallel()
	actor := providerTestActor("folder-a")
	id := "pbk_" + domain.PlaybookScopeKey(actor) + "_abcdefgh"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		labels := expectedOwnershipLabels(actor.FolderUID)
		foreignLabels := expectedOwnershipLabels("folder-b")
		_, _ = w.Write([]byte(`{"dags":[{"fileName":"` + id + `","dag":{"name":"safe","labels":["aegis.managed=` + labels[labelManaged] + `","aegis.owner.kind=` + labels[labelOwnerKind] + `","aegis.owner.version=` + labels[labelOwnerVersion] + `","aegis.folder.key=` + labels[labelFolderKey] + `"]}},{"fileName":"` + id + `_foreign","dag":{"name":"same-scope-foreign-folder","labels":["aegis.managed=` + foreignLabels[labelManaged] + `","aegis.owner.kind=` + foreignLabels[labelOwnerKind] + `","aegis.owner.version=` + foreignLabels[labelOwnerVersion] + `","aegis.folder.key=` + foreignLabels[labelFolderKey] + `"]}},{"fileName":"foreign.yaml","dag":{"name":"foreign"}}],"pagination":{"currentPage":1,"perPage":10,"totalPages":1}}`))
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, server.Client())
	provider, _ := NewProvider(client)
	page, err := provider.List(context.Background(), actor, domain.PageRequest{Limit: 10})
	if err != nil || len(page.Items) != 1 || page.Items[0].Ref.ID != domain.ID(id) || page.Items[0].FolderUID != actor.FolderUID {
		t.Fatalf("page = %#v, err = %v", page, err)
	}
}

func TestProviderEnforcesStoredFolderOwnershipBeforeReadWriteAndRun(t *testing.T) {
	t.Parallel()
	mutations := 0
	runQueries := 0
	updatedSpec := ""
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch request.Method + " " + request.URL.Path {
		case "GET /api/v1/dags/pbk_abcdefgh":
			writeOwnedDAG(w, "folder-a", "name: owned\nsteps: []\n")
		case "PUT /api/v1/dags/pbk_abcdefgh/spec":
			mutations++
			var body map[string]string
			_ = json.NewDecoder(request.Body).Decode(&body)
			updatedSpec = body["spec"]
			w.WriteHeader(http.StatusNoContent)
		case "DELETE /api/v1/dags/pbk_abcdefgh":
			mutations++
			w.WriteHeader(http.StatusNoContent)
		case "POST /api/v1/dags/pbk_abcdefgh/start":
			mutations++
			_, _ = w.Write([]byte(`{"dagRunId":"run_abcdefgh"}`))
		case "GET /api/v1/dag-runs":
			runQueries++
			_, _ = w.Write([]byte(`{"dagRuns":[]}`))
		default:
			t.Errorf("unexpected request %s %s", request.Method, request.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, server.Client())
	provider, _ := NewProvider(client)
	ref := ports.PlaybookRef{ID: "pbk_abcdefgh"}
	foreign := providerTestActor("folder-b")

	if _, err := provider.Get(context.Background(), foreign, ref); !isNotFoundError(err) {
		t.Fatalf("foreign Get error = %#v", err)
	}
	if err := provider.Update(context.Background(), foreign, ref, []byte("steps: []\n")); !isNotFoundError(err) {
		t.Fatalf("foreign Update error = %#v", err)
	}
	if err := provider.Delete(context.Background(), foreign, ref); !isNotFoundError(err) {
		t.Fatalf("foreign Delete error = %#v", err)
	}
	if _, err := provider.StartRun(context.Background(), foreign, ref, ports.RunPlaybookInput{ID: "run_abcdefgh"}); !isNotFoundError(err) {
		t.Fatalf("foreign StartRun error = %#v", err)
	}
	if _, err := provider.ListRuns(context.Background(), foreign, ref, domain.PageRequest{}); !isNotFoundError(err) {
		t.Fatalf("foreign ListRuns error = %#v", err)
	}
	if mutations != 0 || runQueries != 0 {
		t.Fatalf("foreign request reached mutation/run endpoints: mutations=%d run_queries=%d", mutations, runQueries)
	}

	if err := provider.Update(context.Background(), providerTestActor("folder-a"), ref, []byte("name: changed\nsteps: []\n")); err != nil {
		t.Fatal(err)
	}
	if mutations != 1 || !specOwnedByFolder(updatedSpec, "folder-a") || strings.Contains(updatedSpec, "folder-a") {
		t.Fatalf("updated ownership was not safely preserved: mutations=%d spec=%q", mutations, updatedSpec)
	}
}

func TestProviderKeepsConfiguredLegacyPlaybooksReadOnly(t *testing.T) {
	t.Parallel()
	actor := providerTestActor("legacy-ops")
	legacyID := domain.ID("pbk_" + domain.PlaybookLegacyScopeKey(actor) + "_abcdefgh")
	mutations := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch {
		case request.Method == http.MethodGet && request.URL.Path == "/api/v1/dags":
			_, _ = w.Write([]byte(`{"dags":[{"fileName":"` + string(legacyID) + `","dag":{"name":"legacy"}}],"pagination":{"currentPage":1,"perPage":10,"totalPages":1}}`))
		case request.Method == http.MethodGet && request.URL.Path == "/api/v1/dags/"+string(legacyID):
			_ = json.NewEncoder(w).Encode(map[string]any{"spec": "name: legacy\nsteps: []\n"})
		case request.Method == http.MethodGet && request.URL.Path == "/api/v1/dag-runs":
			if request.URL.Query().Get("dagRunId") != "" {
				_, _ = w.Write([]byte(`{"dagRuns":[{"dagRunId":"run_abcdefgh","name":"legacy","labels":["` + playbookRunLabel(string(legacyID)) + `"]}]}`))
				return
			}
			_, _ = w.Write([]byte(`{"dagRuns":[]}`))
		case request.Method == http.MethodGet && strings.HasSuffix(request.URL.Path, "/artifacts"):
			_, _ = w.Write([]byte(`{"items":[{"name":"report.md","path":"report.md"}]}`))
		default:
			mutations++
			w.WriteHeader(http.StatusNoContent)
		}
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, server.Client())
	provider, err := NewProvider(client, WithLegacyFolderUID(actor.FolderUID))
	if err != nil {
		t.Fatal(err)
	}
	ref := ports.PlaybookRef{ID: legacyID}
	runRef := ports.PlaybookRunRef{ID: "run_abcdefgh", PlaybookID: legacyID}

	page, err := provider.List(context.Background(), actor, domain.PageRequest{Limit: 10})
	if err != nil || len(page.Items) != 1 || page.Items[0].Ref != ref {
		t.Fatalf("legacy list = %#v, err = %v", page, err)
	}
	if _, err := provider.Get(context.Background(), actor, ref); err != nil {
		t.Fatalf("legacy Get error = %v", err)
	}
	if _, err := provider.ListRuns(context.Background(), actor, ref, domain.PageRequest{}); err != nil {
		t.Fatalf("legacy ListRuns error = %v", err)
	}
	artifacts, err := provider.ListArtifacts(context.Background(), actor, runRef)
	if err != nil || len(artifacts) != 1 {
		t.Fatalf("legacy artifacts = %#v, err = %v", artifacts, err)
	}
	if _, err := provider.Get(context.Background(), providerTestActor("other"), ref); !isNotFoundError(err) {
		t.Fatalf("legacy resource escaped configured Folder: %#v", err)
	}

	writes := []func() error{
		func() error { return provider.Update(context.Background(), actor, ref, []byte("steps: []\n")) },
		func() error { return provider.Delete(context.Background(), actor, ref) },
		func() error {
			_, err := provider.StartRun(context.Background(), actor, ref, ports.RunPlaybookInput{ID: "run_new12345"})
			return err
		},
		func() error { return provider.CancelRun(context.Background(), actor, runRef) },
		func() error {
			_, err := provider.RetryRun(context.Background(), actor, runRef, "run_new12345")
			return err
		},
		func() error { return provider.CompleteHumanTask(context.Background(), actor, runRef, "review", nil) },
		func() error {
			return provider.ResolveApproval(context.Background(), actor, runRef, "approve", ports.ApprovalApprove, nil)
		},
	}
	for index, write := range writes {
		if err := write(); !isNotFoundError(err) {
			t.Fatalf("legacy write %d error = %#v", index, err)
		}
	}
	if mutations != 0 {
		t.Fatalf("legacy writes reached Dagu mutations: %d", mutations)
	}
}

func isNotFoundError(err error) bool {
	var appErr *domain.AppError
	return errors.As(err, &appErr) && appErr.Code == domain.ErrorNotFound
}

func TestProviderRejectsInvalidIDsAndArtifactTraversalBeforeCallingDagu(t *testing.T) {
	t.Parallel()
	called := false
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called = true }))
	defer server.Close()
	client, _ := NewClient(server.URL, server.Client())
	provider, _ := NewProvider(client)
	_, err := provider.StartRun(context.Background(), providerTestActor("folder-a"), ports.PlaybookRef{ID: "provider_internal"}, ports.RunPlaybookInput{ID: "run_abcdefgh"})
	if err == nil {
		t.Fatal("expected invalid playbook ID")
	}
	_, err = provider.PreviewArtifact(context.Background(), providerTestActor("folder-a"), ports.PlaybookRunRef{ID: "run_abcdefgh", PlaybookID: "pbk_abcdefgh"}, "../secret")
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
		case "/api/v1/dags/pbk_abcdefgh":
			writeOwnedDAG(w, "folder-a", "steps: []\n")
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
	state, err := provider.GetRun(context.Background(), providerTestActor("folder-a"), ports.PlaybookRunRef{ID: "run_abcdefgh"})
	if err != nil || state.Ref.PlaybookID != "pbk_abcdefgh" {
		t.Fatalf("state = %#v, err = %v", state, err)
	}
}

func TestProviderUsesResolvedDisplayNameForRunArtifacts(t *testing.T) {
	t.Parallel()
	label := playbookRunLabel("pbk_abcdefgh")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/api/v1/dags/pbk_abcdefgh":
			writeOwnedDAG(w, "folder-a", "steps: []\n")
		case "/api/v1/dag-runs":
			_, _ = w.Write([]byte(`{"dagRuns":[{"dagRunId":"run_abcdefgh","name":"renamed-playbook","labels":["` + label + `"]}]}`))
		case "/api/v1/dag-runs/renamed-playbook/run_abcdefgh/artifacts":
			_, _ = w.Write([]byte(`{"items":[{"name":"report.md","path":"reports/report.md","type":"text/markdown","size":12}]}`))
		default:
			t.Errorf("path = %q", request.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, server.Client())
	provider, _ := NewProvider(client)
	artifacts, err := provider.ListArtifacts(context.Background(), providerTestActor("folder-a"), ports.PlaybookRunRef{ID: "run_abcdefgh", PlaybookID: "pbk_abcdefgh"})
	if err != nil || len(artifacts) != 1 || artifacts[0].Path != "reports/report.md" {
		t.Fatalf("artifacts = %#v, err = %v", artifacts, err)
	}
}

func TestProviderListsOnlyPublicRunsForRequestedPlaybook(t *testing.T) {
	t.Parallel()
	label := playbookRunLabel("pbk_abcdefgh")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/api/v1/dags/pbk_abcdefgh" {
			writeOwnedDAG(w, "folder-a", "steps: []\n")
			return
		}
		if request.URL.Query().Get("limit") != "3" {
			t.Errorf("query = %q", request.URL.RawQuery)
		}
		switch {
		case request.URL.Query().Get("labels") == label:
			_, _ = w.Write([]byte(`{"dagRuns":[{"dagRunId":"run_new12345","name":"renamed","labels":["` + label + `"],"statusLabel":"running","startedAt":"2026-08-15T02:00:00Z"}]}`))
		case request.URL.Query().Get("name") == "pbk_abcdefgh":
			_, _ = w.Write([]byte(`{"dagRuns":[
				{"dagRunId":"run_first123","name":"pbk_abcdefgh","statusLabel":"success","startedAt":"2026-08-15T01:00:00Z"},
				{"dagRunId":"internal","name":"pbk_abcdefgh","statusLabel":"running"},
				{"dagRunId":"run_foreign","name":"pbk_foreign","statusLabel":"failed"}
			]}`))
		default:
			t.Errorf("query = %q", request.URL.RawQuery)
		}
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, server.Client())
	provider, _ := NewProvider(client)
	page, err := provider.ListRuns(context.Background(), providerTestActor("folder-a"), ports.PlaybookRef{ID: "pbk_abcdefgh"}, domain.PageRequest{Limit: 2})
	if err != nil || len(page.Items) != 2 || page.Items[0].Ref.ID != "run_new12345" || page.Items[1].Ref.ID != "run_first123" || page.HasMore {
		t.Fatalf("page = %#v, err = %v", page, err)
	}
}

func TestProviderPaginatesRunsWithOpaqueCursor(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/api/v1/dags/pbk_abcdefgh" {
			writeOwnedDAG(w, "folder-a", "steps: []\n")
			return
		}
		_, _ = w.Write([]byte(`{"dagRuns":[
			{"dagRunId":"run_first123","name":"pbk_abcdefgh","statusLabel":"success"},
			{"dagRunId":"run_second12","name":"pbk_abcdefgh","statusLabel":"failed"},
			{"dagRunId":"run_third123","name":"pbk_abcdefgh","statusLabel":"running"}
		]}`))
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, server.Client())
	provider, _ := NewProvider(client)
	actor := providerTestActor("folder-a")
	first, err := provider.ListRuns(context.Background(), actor, ports.PlaybookRef{ID: "pbk_abcdefgh"}, domain.PageRequest{Limit: 2})
	if err != nil || len(first.Items) != 2 || !first.HasMore || first.NextCursor == "" {
		t.Fatalf("first page = %#v, err = %v", first, err)
	}
	second, err := provider.ListRuns(context.Background(), actor, ports.PlaybookRef{ID: "pbk_abcdefgh"}, domain.PageRequest{Limit: 2, Cursor: first.NextCursor})
	if err != nil || len(second.Items) != 1 || second.Items[0].Ref.ID != "run_third123" || second.HasMore || second.NextCursor != "" {
		t.Fatalf("second page = %#v, err = %v", second, err)
	}
}

func TestProviderRecoversIdempotentCreateConflict(t *testing.T) {
	t.Parallel()
	requests := 0
	createdSpec := ""
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		requests++
		switch request.Method + " " + request.URL.Path {
		case "POST /api/v1/dags":
			var body map[string]string
			_ = json.NewDecoder(request.Body).Decode(&body)
			createdSpec = body["spec"]
			w.WriteHeader(http.StatusConflict)
		case "GET /api/v1/dags/pbk_abcdefgh":
			_ = json.NewEncoder(w).Encode(map[string]string{"spec": createdSpec})
		default:
			t.Errorf("request = %s %s", request.Method, request.URL.Path)
		}
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, server.Client())
	provider, _ := NewProvider(client)
	ref, err := provider.Create(context.Background(), domain.ActorContext{FolderUID: "folder-a"}, ports.CreatePlaybookInput{ID: "pbk_abcdefgh", YAML: []byte("steps: []")})
	if err != nil || ref.ID != "pbk_abcdefgh" || requests != 2 || !specOwnedByFolder(createdSpec, "folder-a") {
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
	_, err := provider.Create(context.Background(), domain.ActorContext{FolderUID: "folder-a"}, ports.CreatePlaybookInput{ID: "pbk_abcdefgh", YAML: []byte("name: requested\nsteps: []\n")})
	var httpErr *HTTPError
	if !errors.As(err, &httpErr) || httpErr.StatusCode != http.StatusConflict {
		t.Fatalf("error = %#v", err)
	}
}

func TestProviderGetsNameAndDescriptionFromNativeYAML(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeOwnedDAG(w, "folder-a", "name: diagnose\ndescription: Diagnose service\nsteps: []\n")
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, server.Client())
	provider, _ := NewProvider(client)
	resource, err := provider.Get(context.Background(), providerTestActor("folder-a"), ports.PlaybookRef{ID: "pbk_abcdefgh"})
	if err != nil || resource.FolderUID != "folder-a" || resource.Name != "diagnose" || resource.Description != "Diagnose service" {
		t.Fatalf("resource = %#v, err = %v", resource, err)
	}
}

func TestProviderRecoversIdempotentRunConflicts(t *testing.T) {
	t.Parallel()
	label := playbookRunLabel("pbk_abcdefgh")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch request.Method + " " + request.URL.Path {
		case "GET /api/v1/dags/pbk_abcdefgh":
			writeOwnedDAG(w, "folder-a", "steps: []\n")
		case "POST /api/v1/dags/pbk_abcdefgh/start",
			"POST /api/v1/dag-runs/renamed/run_original/retry":
			w.WriteHeader(http.StatusConflict)
		case "GET /api/v1/dag-runs":
			runID := request.URL.Query().Get("dagRunId")
			_, _ = w.Write([]byte(`{"dagRuns":[{"dagRunId":"` + runID + `","name":"renamed","labels":["` + label + `"]}]}`))
		default:
			t.Errorf("request = %s %s", request.Method, request.URL.Path)
		}
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, server.Client())
	provider, _ := NewProvider(client)

	actor := providerTestActor("folder-a")
	started, err := provider.StartRun(context.Background(), actor, ports.PlaybookRef{ID: "pbk_abcdefgh"}, ports.RunPlaybookInput{ID: "run_abcdefgh"})
	if err != nil || started.ID != "run_abcdefgh" {
		t.Fatalf("started = %#v, err = %v", started, err)
	}
	retried, err := provider.RetryRun(context.Background(), actor, ports.PlaybookRunRef{ID: "run_original", PlaybookID: "pbk_abcdefgh"}, "run_abcdefgh")
	if err != nil || retried.ID != "run_abcdefgh" {
		t.Fatalf("retried = %#v, err = %v", retried, err)
	}
}

func TestProviderDoesNotHideUnverifiedConflict(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if request.Method == http.MethodGet && request.URL.Path == "/api/v1/dags/pbk_abcdefgh" {
			writeOwnedDAG(w, "folder-a", "steps: []\n")
			return
		}
		if request.Method == http.MethodPost {
			w.WriteHeader(http.StatusConflict)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()
	client, _ := NewClient(server.URL, server.Client())
	provider, _ := NewProvider(client)
	_, err := provider.StartRun(context.Background(), providerTestActor("folder-a"), ports.PlaybookRef{ID: "pbk_abcdefgh"}, ports.RunPlaybookInput{ID: "run_abcdefgh"})
	var httpErr *HTTPError
	if !errors.As(err, &httpErr) || httpErr.StatusCode != http.StatusConflict {
		t.Fatalf("error = %#v", err)
	}
}
