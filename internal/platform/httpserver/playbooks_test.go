package httpserver

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

	"github.com/1024XEngineer/aegis-sre/internal/domain"
	"github.com/1024XEngineer/aegis-sre/internal/platform/config"
	"github.com/1024XEngineer/aegis-sre/internal/ports"
	"github.com/1024XEngineer/aegis-sre/internal/ports/contracttest"
)

type playbookHTTPFake struct {
	contracttest.PlaybookProvider
	created        ports.CreatePlaybookInput
	runRef         ports.PlaybookRunRef
	runPlaybookID  domain.ID
	err            error
	getCalls       int
	runGetCalls    int
	startCalls     int
	cancelCalls    int
	humanTaskCalls int
	approvalCalls  int
	checkErr       error
}

func (fake *playbookHTTPFake) Check(context.Context) error { return fake.checkErr }

func (fake *playbookHTTPFake) ListRuns(_ context.Context, _ domain.ActorContext, ref ports.PlaybookRef, _ domain.PageRequest) (domain.Page[ports.PlaybookRunState], error) {
	return domain.Page[ports.PlaybookRunState]{Items: []ports.PlaybookRunState{{
		Ref: ports.PlaybookRunRef{ID: "run_abcdefgh", PlaybookID: ref.ID}, Status: domain.RunRunning,
		StartedAt: time.Date(2026, 8, 13, 1, 0, 0, 0, time.UTC),
	}}}, fake.err
}

func (fake *playbookHTTPFake) Create(_ context.Context, _ domain.ActorContext, input ports.CreatePlaybookInput) (ports.PlaybookRef, error) {
	fake.created = input
	return ports.PlaybookRef{ID: input.ID}, fake.err
}

func (fake *playbookHTTPFake) Get(_ context.Context, _ domain.ActorContext, ref ports.PlaybookRef) (ports.PlaybookResource, error) {
	fake.getCalls++
	return ports.PlaybookResource{Ref: ref, Name: "diagnose", Description: "Diagnose service", YAML: fake.created.YAML, Enabled: true}, fake.err
}

func (fake *playbookHTTPFake) Validate(_ context.Context, _ domain.ActorContext, _ []byte) ([]ports.ValidationIssue, error) {
	return []ports.ValidationIssue{{Path: "steps[0]", Message: "action is required"}}, fake.err
}

func (fake *playbookHTTPFake) StartRun(_ context.Context, _ domain.ActorContext, ref ports.PlaybookRef, input ports.RunPlaybookInput) (ports.PlaybookRunRef, error) {
	fake.startCalls++
	return ports.PlaybookRunRef{ID: input.ID, PlaybookID: ref.ID}, fake.err
}

func (fake *playbookHTTPFake) GetRun(_ context.Context, actor domain.ActorContext, ref ports.PlaybookRunRef) (ports.PlaybookRunState, error) {
	fake.runGetCalls++
	fake.runRef = ref
	ref.PlaybookID = fake.runPlaybookID
	if ref.PlaybookID == "" {
		ref.PlaybookID = scopedPlaybookID(actor, "run-owner")
	}
	return ports.PlaybookRunState{Ref: ref, Status: domain.RunRunning, StartedAt: time.Date(2026, 8, 13, 1, 0, 0, 0, time.UTC)}, fake.err
}

func (fake *playbookHTTPFake) CancelRun(_ context.Context, _ domain.ActorContext, ref ports.PlaybookRunRef) error {
	fake.cancelCalls++
	fake.runRef = ref
	return fake.err
}

func (fake *playbookHTTPFake) CompleteHumanTask(_ context.Context, _ domain.ActorContext, ref ports.PlaybookRunRef, _ string, _ map[string]any) error {
	fake.humanTaskCalls++
	fake.runRef = ref
	return fake.err
}

func (fake *playbookHTTPFake) ResolveApproval(_ context.Context, _ domain.ActorContext, ref ports.PlaybookRunRef, _ string, _ ports.ApprovalAction, _ map[string]string) error {
	fake.approvalCalls++
	fake.runRef = ref
	return fake.err
}

func (fake *playbookHTTPFake) StreamRun(_ context.Context, _ domain.ActorContext, ref ports.PlaybookRunRef, after int64) (ports.EventStream, error) {
	fake.runRef = ref
	return &contracttest.EventStream{Events: []domain.Event{{ID: "evt_abcdefgh", Type: domain.EventRunUpdated, RunID: ref.ID, Sequence: after + 1, OccurredAt: time.Date(2026, 8, 13, 1, 0, 0, 0, time.UTC), Payload: json.RawMessage(`{"status":"running"}`)}}}, fake.err
}

func TestCreatePlaybookUsesStablePublicIDAndNativeYAML(t *testing.T) {
	t.Parallel()
	fake := &playbookHTTPFake{}
	handler := New(config.Config{Endpoints: map[config.Capability]string{config.CapabilityPlaybook: "http://dagu"}}, nil, WithPlaybookProvider(fake)).Handler
	request := actorRequest(http.MethodPost, "/api/v1/playbooks", "name: diagnose\nsteps: []\n")
	request.Header.Set("Content-Type", "application/yaml")
	request.Header.Set("Idempotency-Key", "create-diagnose")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if !strings.HasPrefix(string(fake.created.ID), "pbk_") || string(fake.created.YAML) != "name: diagnose\nsteps: []\n" {
		t.Fatalf("input = %#v", fake.created)
	}
	if strings.Contains(response.Body.String(), "provider") || strings.Contains(response.Body.String(), "dagu") {
		t.Fatalf("provider detail leaked: %s", response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"description":"Diagnose service"`) || !strings.Contains(response.Body.String(), `"source":"name: diagnose`) {
		t.Fatalf("missing native detail fields: %s", response.Body.String())
	}

	repeat := actorRequest(http.MethodPost, "/api/v1/playbooks", "name: diagnose\nsteps: []\n")
	repeat.Header.Set("Idempotency-Key", "create-diagnose")
	repeatResponse := httptest.NewRecorder()
	handler.ServeHTTP(repeatResponse, repeat)
	var first, second map[string]any
	_ = json.Unmarshal(response.Body.Bytes(), &first)
	_ = json.Unmarshal(repeatResponse.Body.Bytes(), &second)
	if first["id"] != second["id"] {
		t.Fatalf("stable IDs differ: %v != %v", first["id"], second["id"])
	}
}

func TestPlaybookCRUDEnforcesGrafanaOrgScopeAndWriteRole(t *testing.T) {
	t.Parallel()
	fake := &playbookHTTPFake{}
	handler := New(config.Config{Endpoints: map[config.Capability]string{}}, nil, WithPlaybookProvider(fake)).Handler

	viewer := actorRequest(http.MethodPost, "/api/v1/playbooks", "name: denied\nsteps: []\n")
	viewer.Header.Set("X-Aegis-Roles", "Viewer")
	viewer.Header.Set("Idempotency-Key", "viewer-create")
	viewerResponse := httptest.NewRecorder()
	handler.ServeHTTP(viewerResponse, viewer)
	if viewerResponse.Code != http.StatusForbidden {
		t.Fatalf("viewer status = %d", viewerResponse.Code)
	}

	owner := domain.ActorContext{TenantID: "tenant", OrgID: "org", UserID: "user"}
	id := scopedPlaybookID(owner, "org-resource")
	foreign := actorRequest(http.MethodGet, "/api/v1/playbooks/"+string(id), "")
	foreign.Header.Set(headerOrgID, "another-org")
	foreignResponse := httptest.NewRecorder()
	handler.ServeHTTP(foreignResponse, foreign)
	if foreignResponse.Code != http.StatusNotFound || fake.getCalls != 0 {
		t.Fatalf("foreign status = %d, provider calls = %d", foreignResponse.Code, fake.getCalls)
	}
}

func TestValidateNewPlaybookUsesPublicLowercaseIssues(t *testing.T) {
	t.Parallel()
	handler := New(config.Config{Endpoints: map[config.Capability]string{}}, nil, WithPlaybookProvider(&playbookHTTPFake{})).Handler
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, actorRequest(http.MethodPost, "/api/v1/playbooks/validate", "steps:\n  - id: inspect\n"))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"path":"steps[0]"`) || strings.Contains(response.Body.String(), `"Path"`) {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
}

func TestGetRunResolvesOnlyPublicRunID(t *testing.T) {
	t.Parallel()
	fake := &playbookHTTPFake{}
	handler := New(config.Config{Endpoints: map[config.Capability]string{}}, nil, WithPlaybookProvider(fake)).Handler
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, actorRequest(http.MethodGet, "/api/v1/runs/run_abcdefgh", ""))
	if response.Code != http.StatusOK || fake.runRef.ID != "run_abcdefgh" || fake.runRef.PlaybookID != "" {
		t.Fatalf("status = %d, ref = %#v, body = %s", response.Code, fake.runRef, response.Body.String())
	}
}

func TestRunEventStreamResumesAfterSequence(t *testing.T) {
	t.Parallel()
	fake := &playbookHTTPFake{}
	handler := New(config.Config{Endpoints: map[config.Capability]string{}}, nil, WithPlaybookProvider(fake)).Handler
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, actorRequest(http.MethodGet, "/api/v1/runs/run_abcdefgh/events?after_sequence=7", ""))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "id: 8") || !strings.Contains(response.Body.String(), `"run_id":"run_abcdefgh"`) {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
}

func TestListPlaybookRunsReturnsProviderHistory(t *testing.T) {
	t.Parallel()
	fake := &playbookHTTPFake{}
	handler := New(config.Config{Endpoints: map[config.Capability]string{}}, nil, WithPlaybookProvider(fake)).Handler
	response := httptest.NewRecorder()
	id := scopedPlaybookID(domain.ActorContext{TenantID: "tenant", OrgID: "org", UserID: "user"}, "run-history")
	handler.ServeHTTP(response, actorRequest(http.MethodGet, "/api/v1/playbooks/"+string(id)+"/runs", ""))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"id":"run_abcdefgh"`) {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
}

func TestPlaybookRunStartEnforcesScopeRoleAndResourceScopedIdempotency(t *testing.T) {
	t.Parallel()
	actor := domain.ActorContext{TenantID: "tenant", OrgID: "org", UserID: "user"}
	firstID := scopedPlaybookID(actor, "first-playbook")
	secondID := scopedPlaybookID(actor, "second-playbook")
	fake := &playbookHTTPFake{}
	handler := New(config.Config{Endpoints: map[config.Capability]string{}}, nil, WithPlaybookProvider(fake)).Handler

	viewer := actorRequest(http.MethodPost, "/api/v1/playbooks/"+string(firstID)+"/runs", `{}`)
	viewer.Header.Set("X-Aegis-Roles", "Viewer")
	viewer.Header.Set("Idempotency-Key", "same-request-key")
	viewerResponse := httptest.NewRecorder()
	handler.ServeHTTP(viewerResponse, viewer)
	if viewerResponse.Code != http.StatusForbidden || fake.startCalls != 0 {
		t.Fatalf("viewer status = %d, start calls = %d", viewerResponse.Code, fake.startCalls)
	}

	foreign := actorRequest(http.MethodPost, "/api/v1/playbooks/"+string(firstID)+"/runs", `{}`)
	foreign.Header.Set(headerOrgID, "another-org")
	foreign.Header.Set("Idempotency-Key", "same-request-key")
	foreignResponse := httptest.NewRecorder()
	handler.ServeHTTP(foreignResponse, foreign)
	if foreignResponse.Code != http.StatusNotFound || fake.startCalls != 0 {
		t.Fatalf("foreign status = %d, start calls = %d", foreignResponse.Code, fake.startCalls)
	}

	var runIDs []string
	for _, id := range []domain.ID{firstID, secondID} {
		request := actorRequest(http.MethodPost, "/api/v1/playbooks/"+string(id)+"/runs", `{}`)
		request.Header.Set("Idempotency-Key", "same-request-key")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusAccepted {
			t.Fatalf("start %s status = %d, body = %s", id, response.Code, response.Body.String())
		}
		var body map[string]any
		_ = json.Unmarshal(response.Body.Bytes(), &body)
		runIDs = append(runIDs, body["id"].(string))
	}
	if runIDs[0] == runIDs[1] || fake.startCalls != 2 {
		t.Fatalf("run IDs = %v, start calls = %d", runIDs, fake.startCalls)
	}
}

func TestPlaybookRunRoutesRejectForeignOrgAndViewerMutations(t *testing.T) {
	t.Parallel()
	owner := domain.ActorContext{TenantID: "tenant", OrgID: "org", UserID: "user"}
	fake := &playbookHTTPFake{runPlaybookID: scopedPlaybookID(owner, "owned-run")}
	handler := New(config.Config{Endpoints: map[config.Capability]string{}}, nil, WithPlaybookProvider(fake)).Handler

	foreign := actorRequest(http.MethodGet, "/api/v1/runs/run_abcdefgh", "")
	foreign.Header.Set(headerOrgID, "another-org")
	foreignResponse := httptest.NewRecorder()
	handler.ServeHTTP(foreignResponse, foreign)
	if foreignResponse.Code != http.StatusNotFound {
		t.Fatalf("foreign status = %d, body = %s", foreignResponse.Code, foreignResponse.Body.String())
	}

	mutations := []struct {
		target string
		body   string
	}{
		{target: "/api/v1/runs/run_abcdefgh:cancel"},
		{target: "/api/v1/runs/run_abcdefgh/human-tasks/review:complete", body: `{}`},
		{target: "/api/v1/runs/run_abcdefgh/approvals/review:resolve", body: `{"decision":"approve"}`},
	}
	for _, mutation := range mutations {
		request := actorRequest(http.MethodPost, mutation.target, mutation.body)
		request.Header.Set("X-Aegis-Roles", "Viewer")
		request.Header.Set("Idempotency-Key", "viewer-action")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusForbidden {
			t.Errorf("%s status = %d, body = %s", mutation.target, response.Code, response.Body.String())
		}
	}
	if fake.cancelCalls != 0 || fake.humanTaskCalls != 0 || fake.approvalCalls != 0 {
		t.Fatalf("mutation calls = cancel:%d human:%d approval:%d", fake.cancelCalls, fake.humanTaskCalls, fake.approvalCalls)
	}
}

func TestPlaybookAPIRejectsInvalidInputAndSanitizesProviderErrors(t *testing.T) {
	t.Parallel()
	t.Run("invalid id", func(t *testing.T) {
		handler := New(config.Config{Endpoints: map[config.Capability]string{}}, nil, WithPlaybookProvider(&playbookHTTPFake{})).Handler
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, actorRequest(http.MethodGet, "/api/v1/playbooks/dagu-internal", ""))
		if response.Code != http.StatusBadRequest {
			t.Fatalf("status = %d", response.Code)
		}
	})
	t.Run("provider detail", func(t *testing.T) {
		fake := &playbookHTTPFake{err: errors.New("Dagu secret internal response")}
		handler := New(config.Config{Endpoints: map[config.Capability]string{}}, nil, WithPlaybookProvider(fake)).Handler
		response := httptest.NewRecorder()
		id := scopedPlaybookID(domain.ActorContext{TenantID: "tenant", OrgID: "org", UserID: "user"}, "provider-detail")
		handler.ServeHTTP(response, actorRequest(http.MethodGet, "/api/v1/playbooks/"+string(id), ""))
		if response.Code != http.StatusBadGateway || strings.Contains(response.Body.String(), "secret") || strings.Contains(response.Body.String(), "Dagu") {
			t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
		}
	})
}

func actorRequest(method, target, body string) *http.Request {
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	request := httptest.NewRequest(method, target, reader)
	request.Header.Set(headerTenantID, "tenant")
	request.Header.Set(headerOrgID, "org")
	request.Header.Set(headerUserID, "user")
	request.Header.Set("X-Aegis-Roles", "Editor")
	return request
}
