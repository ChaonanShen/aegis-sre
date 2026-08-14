package playbookmcp

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/1024XEngineer/aegis-sre/internal/domain"
	"github.com/1024XEngineer/aegis-sre/internal/ports"
	"github.com/1024XEngineer/aegis-sre/internal/ports/contracttest"
)

type fakeProvider struct {
	contracttest.PlaybookProvider
	listed    []ports.PlaybookResource
	validated []ports.ValidationIssue
	started   ports.RunPlaybookInput
	run       ports.PlaybookRunRef
}

func (f *fakeProvider) List(context.Context, domain.ActorContext, domain.PageRequest) (domain.Page[ports.PlaybookResource], error) {
	return domain.Page[ports.PlaybookResource]{Items: f.listed}, nil
}

func (f *fakeProvider) Validate(context.Context, domain.ActorContext, []byte) ([]ports.ValidationIssue, error) {
	return f.validated, nil
}

func (f *fakeProvider) StartRun(_ context.Context, _ domain.ActorContext, ref ports.PlaybookRef, input ports.RunPlaybookInput) (ports.PlaybookRunRef, error) {
	f.started = input
	f.run = ports.PlaybookRunRef{ID: input.ID, PlaybookID: ref.ID}
	return f.run, nil
}

func (f *fakeProvider) GetRun(context.Context, domain.ActorContext, ports.PlaybookRunRef) (ports.PlaybookRunState, error) {
	return ports.PlaybookRunState{Ref: f.run, Status: domain.RunRunning}, nil
}

func TestPlaybookMCPToolsUseAuthorizedFolderAndStableRunID(t *testing.T) {
	tokenFile := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenFile, []byte("secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	actor := domain.ActorContext{TenantID: "tenant", OrgID: "org", UserID: "user", FolderUID: "ops"}
	playbookID := domain.ID("pbk_" + domain.PlaybookScopeKey(actor) + "_abcdefgh")
	fake := &fakeProvider{listed: []ports.PlaybookResource{{Ref: ports.PlaybookRef{ID: playbookID}, Name: "diagnose", Enabled: true}}}
	svc := &service{provider: fake, config: Config{TenantID: "tenant", OrgID: "org", UserID: "user"}, folders: map[string]struct{}{"ops": {}}}

	listResult, listOutput, err := svc.list(context.Background(), nil, listInput{FolderUID: "ops"})
	if err != nil || listResult != nil || len(listOutput.Items) != 1 || listOutput.Items[0].ID != string(playbookID) {
		t.Fatalf("list output = %+v, result = %+v, err = %v", listOutput, listResult, err)
	}
	_, output, err := svc.start(context.Background(), nil, startInput{FolderUID: "ops", PlaybookID: string(playbookID), IdempotencyKey: "incident-123", Parameters: map[string]string{"service": "api"}})
	if err != nil || output.RunID == "" || fake.started.Parameters["service"] != "api" {
		t.Fatalf("start output = %+v, input = %+v, err = %v", output, fake.started, err)
	}
	_, repeated, err := svc.start(context.Background(), nil, startInput{FolderUID: "ops", PlaybookID: string(playbookID), IdempotencyKey: "incident-123"})
	if err != nil || repeated.RunID != output.RunID {
		t.Fatalf("stable run ID changed: first=%+v second=%+v err=%v", output, repeated, err)
	}
	if _, _, err := svc.list(context.Background(), nil, listInput{FolderUID: "payments"}); err == nil {
		t.Fatal("unauthorized Folder must be rejected")
	}
}

func TestNewHandlerRejectsIncompleteConfiguration(t *testing.T) {
	if _, err := NewHandler(&fakeProvider{}, Config{}); err == nil {
		t.Fatal("incomplete Playbook MCP config must be rejected")
	}
}
