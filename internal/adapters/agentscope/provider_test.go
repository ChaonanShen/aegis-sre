package agentscope

import (
	"context"
	"errors"
	"testing"

	"github.com/1024XEngineer/aegis-sre/internal/domain"
	"github.com/1024XEngineer/aegis-sre/internal/ports"
	"github.com/1024XEngineer/aegis-sre/internal/ports/contracttest"
)

type trackingProvider struct {
	contracttest.AgentProvider
	listCalls    int
	createCalls  int
	startCalls   int
	cancelCalls  int
	resolveCalls int
}

func (provider *trackingProvider) ListSessions(ctx context.Context, actor domain.ActorContext, input ports.ListAgentSessionsInput) (domain.Page[ports.AgentSession], error) {
	provider.listCalls++
	return provider.AgentProvider.ListSessions(ctx, actor, input)
}

func (provider *trackingProvider) CreateSession(ctx context.Context, actor domain.ActorContext, input ports.CreateAgentSessionInput) (ports.AgentSession, error) {
	provider.createCalls++
	return provider.AgentProvider.CreateSession(ctx, actor, input)
}

func (provider *trackingProvider) StartTurn(ctx context.Context, actor domain.ActorContext, ref ports.AgentSessionRef, input ports.StartTurnInput) (ports.AgentTurnRef, ports.EventStream, error) {
	provider.startCalls++
	return provider.AgentProvider.StartTurn(ctx, actor, ref, input)
}

func (provider *trackingProvider) CancelTurn(ctx context.Context, actor domain.ActorContext, session ports.AgentSessionRef, turn ports.AgentTurnRef) error {
	provider.cancelCalls++
	return provider.AgentProvider.CancelTurn(ctx, actor, session, turn)
}

func (provider *trackingProvider) ResolveApproval(ctx context.Context, actor domain.ActorContext, session ports.AgentSessionRef, decision ports.ApprovalDecision) (ports.EventStream, error) {
	provider.resolveCalls++
	return provider.AgentProvider.ResolveApproval(ctx, actor, session, decision)
}

func TestProviderFailsClosedBeforeAnyAgentOperation(t *testing.T) {
	t.Parallel()
	next := &trackingProvider{}
	provider, err := New(next, Scope{TenantID: "tenant-a", OrgID: "org-a", UserID: "user-a"})
	if err != nil {
		t.Fatal(err)
	}
	foreignActors := []domain.ActorContext{
		{TenantID: "tenant-b", OrgID: "org-a", UserID: "user-a"},
		{TenantID: "tenant-a", OrgID: "org-b", UserID: "user-a"},
		{TenantID: "tenant-a", OrgID: "org-a", UserID: "user-b"},
	}
	for _, actor := range foreignActors {
		_, listErr := provider.ListSessions(context.Background(), actor, ports.ListAgentSessionsInput{})
		_, createErr := provider.CreateSession(context.Background(), actor, ports.CreateAgentSessionInput{})
		_, readErr := provider.ReadSession(context.Background(), actor, ports.AgentSessionRef{})
		_, renameErr := provider.RenameSession(context.Background(), actor, ports.AgentSessionRef{}, "title")
		_, archiveErr := provider.ArchiveSession(context.Background(), actor, ports.AgentSessionRef{})
		_, unarchiveErr := provider.UnarchiveSession(context.Background(), actor, ports.AgentSessionRef{})
		_, stream, startErr := provider.StartTurn(context.Background(), actor, ports.AgentSessionRef{}, ports.StartTurnInput{})
		cancelErr := provider.CancelTurn(context.Background(), actor, ports.AgentSessionRef{}, ports.AgentTurnRef{})
		approvalStream, approvalErr := provider.ResolveApproval(context.Background(), actor, ports.AgentSessionRef{}, ports.ApprovalDecision{})
		deleteErr := provider.DeleteSession(context.Background(), actor, ports.AgentSessionRef{})
		for _, got := range []error{listErr, createErr, readErr, renameErr, archiveErr, unarchiveErr, startErr, cancelErr, approvalErr, deleteErr} {
			var appErr *domain.AppError
			if !errors.As(got, &appErr) || appErr.Code != domain.ErrorForbidden || appErr.Retryable {
				t.Fatalf("actor = %#v, error = %#v", actor, got)
			}
		}
		if stream != nil || approvalStream != nil {
			t.Fatalf("foreign actor received stream: %T / %T", stream, approvalStream)
		}
	}
	if next.listCalls+next.createCalls+next.startCalls+next.cancelCalls+next.resolveCalls != 0 {
		t.Fatalf("underlying provider was called: %#v", next)
	}
}

func TestProviderDelegatesMatchingActorAndHealth(t *testing.T) {
	t.Parallel()
	next := &trackingProvider{AgentProvider: contracttest.AgentProvider{Session: ports.AgentSession{Ref: ports.AgentSessionRef{ID: "ses_abcdefgh"}}}}
	provider, _ := New(next, Scope{TenantID: "tenant-a", OrgID: "org-a", UserID: "user-a"})
	actor := domain.ActorContext{TenantID: "tenant-a", OrgID: "org-a", UserID: "user-a"}
	if _, err := provider.CreateSession(context.Background(), actor, ports.CreateAgentSessionInput{}); err != nil || next.createCalls != 1 {
		t.Fatalf("calls = %d, err = %v", next.createCalls, err)
	}
	if err := provider.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestProviderRequiresCompleteScope(t *testing.T) {
	t.Parallel()
	if _, err := New(&trackingProvider{}, Scope{TenantID: "tenant", OrgID: "org"}); err == nil {
		t.Fatal("incomplete trusted actor scope must be rejected")
	}
}
