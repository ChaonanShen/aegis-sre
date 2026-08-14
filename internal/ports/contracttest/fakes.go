// Package contracttest contains deterministic Provider fakes for contract tests.
// It must never be wired into a real Control Plane process.
package contracttest

import (
	"context"
	"errors"
	"io"

	"github.com/1024XEngineer/aegis-sre/internal/domain"
	"github.com/1024XEngineer/aegis-sre/internal/ports"
)

var ErrNotConfigured = errors.New("contract fake behavior is not configured")

type EventStream struct {
	Events []domain.Event
	index  int
}

func (stream *EventStream) Next(context.Context) (domain.Event, error) {
	if stream.index >= len(stream.Events) {
		return domain.Event{}, io.EOF
	}
	event := stream.Events[stream.index]
	stream.index++
	return event, nil
}

func (*EventStream) Close() error { return nil }

type AgentProvider struct {
	Session       ports.AgentSession
	SessionDetail ports.AgentSessionDetail
	Sessions      domain.Page[ports.AgentSession]
	Turn          ports.AgentTurnRef
	Events        []domain.Event
	Err           error
}

func (fake *AgentProvider) Check(context.Context) error { return fake.Err }
func (fake *AgentProvider) ListSessions(context.Context, domain.ActorContext, ports.ListAgentSessionsInput) (domain.Page[ports.AgentSession], error) {
	return fake.Sessions, fake.Err
}
func (fake *AgentProvider) CreateSession(context.Context, domain.ActorContext, ports.CreateAgentSessionInput) (ports.AgentSession, error) {
	return fake.Session, fake.Err
}
func (fake *AgentProvider) ReadSession(context.Context, domain.ActorContext, ports.AgentSessionRef) (ports.AgentSessionDetail, error) {
	return fake.SessionDetail, fake.Err
}
func (fake *AgentProvider) RenameSession(context.Context, domain.ActorContext, ports.AgentSessionRef, string) (ports.AgentSession, error) {
	return fake.Session, fake.Err
}
func (fake *AgentProvider) ArchiveSession(context.Context, domain.ActorContext, ports.AgentSessionRef) (ports.AgentSession, error) {
	return fake.Session, fake.Err
}
func (fake *AgentProvider) UnarchiveSession(context.Context, domain.ActorContext, ports.AgentSessionRef) (ports.AgentSession, error) {
	return fake.Session, fake.Err
}
func (fake *AgentProvider) StartTurn(context.Context, domain.ActorContext, ports.AgentSessionRef, ports.StartTurnInput) (ports.AgentTurnRef, ports.EventStream, error) {
	return fake.Turn, &EventStream{Events: fake.Events}, fake.Err
}
func (fake *AgentProvider) CancelTurn(context.Context, domain.ActorContext, ports.AgentSessionRef, ports.AgentTurnRef) error {
	return fake.Err
}
func (fake *AgentProvider) ResolveApproval(context.Context, domain.ActorContext, ports.AgentSessionRef, ports.ApprovalDecision) (ports.EventStream, error) {
	return &EventStream{Events: fake.Events}, fake.Err
}
func (fake *AgentProvider) DeleteSession(context.Context, domain.ActorContext, ports.AgentSessionRef) error {
	return fake.Err
}

type KnowledgeProvider struct{ Err error }

func (fake *KnowledgeProvider) Check(context.Context) error { return fake.Err }
func (*KnowledgeProvider) ListCollections(context.Context, domain.ActorContext, string, domain.PageRequest) (domain.Page[ports.KnowledgeCollection], error) {
	return domain.Page[ports.KnowledgeCollection]{}, ErrNotConfigured
}
func (*KnowledgeProvider) GetCollection(context.Context, domain.ActorContext, ports.KnowledgeCollectionRef) (ports.KnowledgeCollection, error) {
	return ports.KnowledgeCollection{}, ErrNotConfigured
}
func (*KnowledgeProvider) CreateCollection(context.Context, domain.ActorContext, ports.CreateKnowledgeCollectionInput) (ports.KnowledgeCollection, error) {
	return ports.KnowledgeCollection{}, ErrNotConfigured
}
func (*KnowledgeProvider) UpdateCollection(context.Context, domain.ActorContext, ports.KnowledgeCollectionRef, ports.UpdateKnowledgeCollectionInput) (ports.KnowledgeCollection, error) {
	return ports.KnowledgeCollection{}, ErrNotConfigured
}
func (fake *KnowledgeProvider) DeleteCollection(context.Context, domain.ActorContext, ports.KnowledgeCollectionRef) error {
	return fake.Err
}
func (*KnowledgeProvider) ListDocuments(context.Context, domain.ActorContext, ports.KnowledgeCollectionRef, domain.PageRequest) (domain.Page[ports.KnowledgeDocument], error) {
	return domain.Page[ports.KnowledgeDocument]{}, ErrNotConfigured
}
func (*KnowledgeProvider) GetDocument(context.Context, domain.ActorContext, ports.KnowledgeDocumentRef) (ports.KnowledgeDocument, error) {
	return ports.KnowledgeDocument{}, ErrNotConfigured
}
func (*KnowledgeProvider) UploadDocument(context.Context, domain.ActorContext, ports.KnowledgeCollectionRef, ports.DocumentFile) (ports.KnowledgeDocument, error) {
	return ports.KnowledgeDocument{}, ErrNotConfigured
}
func (*KnowledgeProvider) UpdateDocument(context.Context, domain.ActorContext, ports.KnowledgeDocumentRef, ports.UpdateKnowledgeDocumentInput) (ports.KnowledgeDocument, error) {
	return ports.KnowledgeDocument{}, ErrNotConfigured
}
func (fake *KnowledgeProvider) StartIndexing(context.Context, domain.ActorContext, ports.KnowledgeDocumentRef) error {
	return fake.Err
}
func (fake *KnowledgeProvider) StopIndexing(context.Context, domain.ActorContext, ports.KnowledgeDocumentRef) error {
	return fake.Err
}
func (fake *KnowledgeProvider) DeleteDocument(context.Context, domain.ActorContext, ports.KnowledgeDocumentRef) error {
	return fake.Err
}
func (*KnowledgeProvider) ListChunks(context.Context, domain.ActorContext, ports.KnowledgeDocumentRef, domain.PageRequest) (domain.Page[ports.KnowledgeChunk], error) {
	return domain.Page[ports.KnowledgeChunk]{}, ErrNotConfigured
}
func (*KnowledgeProvider) DownloadDocument(context.Context, domain.ActorContext, ports.KnowledgeDocumentRef) (ports.KnowledgeDocumentDownload, error) {
	return ports.KnowledgeDocumentDownload{}, ErrNotConfigured
}
func (*KnowledgeProvider) Retrieve(context.Context, domain.ActorContext, ports.RetrievalInput) ([]ports.RetrievalHit, error) {
	return nil, ErrNotConfigured
}

type PlaybookProvider struct{ Err error }

func (*PlaybookProvider) List(context.Context, domain.ActorContext, domain.PageRequest) (domain.Page[ports.PlaybookResource], error) {
	return domain.Page[ports.PlaybookResource]{}, ErrNotConfigured
}
func (*PlaybookProvider) Get(context.Context, domain.ActorContext, ports.PlaybookRef) (ports.PlaybookResource, error) {
	return ports.PlaybookResource{}, ErrNotConfigured
}
func (*PlaybookProvider) Create(context.Context, domain.ActorContext, ports.CreatePlaybookInput) (ports.PlaybookRef, error) {
	return ports.PlaybookRef{}, ErrNotConfigured
}
func (fake *PlaybookProvider) Update(context.Context, domain.ActorContext, ports.PlaybookRef, []byte) error {
	return fake.Err
}
func (fake *PlaybookProvider) Delete(context.Context, domain.ActorContext, ports.PlaybookRef) error {
	return fake.Err
}
func (*PlaybookProvider) Validate(context.Context, domain.ActorContext, []byte) ([]ports.ValidationIssue, error) {
	return nil, ErrNotConfigured
}
func (*PlaybookProvider) StartRun(context.Context, domain.ActorContext, ports.PlaybookRef, ports.RunPlaybookInput) (ports.PlaybookRunRef, error) {
	return ports.PlaybookRunRef{}, ErrNotConfigured
}
func (*PlaybookProvider) ListRuns(context.Context, domain.ActorContext, ports.PlaybookRef, domain.PageRequest) (domain.Page[ports.PlaybookRunState], error) {
	return domain.Page[ports.PlaybookRunState]{}, ErrNotConfigured
}
func (*PlaybookProvider) GetRun(context.Context, domain.ActorContext, ports.PlaybookRunRef) (ports.PlaybookRunState, error) {
	return ports.PlaybookRunState{}, ErrNotConfigured
}
func (fake *PlaybookProvider) CancelRun(context.Context, domain.ActorContext, ports.PlaybookRunRef) error {
	return fake.Err
}
func (*PlaybookProvider) RetryRun(context.Context, domain.ActorContext, ports.PlaybookRunRef, domain.ID) (ports.PlaybookRunRef, error) {
	return ports.PlaybookRunRef{}, ErrNotConfigured
}
func (*PlaybookProvider) StreamRun(context.Context, domain.ActorContext, ports.PlaybookRunRef, int64) (ports.EventStream, error) {
	return nil, ErrNotConfigured
}
func (fake *PlaybookProvider) CompleteHumanTask(context.Context, domain.ActorContext, ports.PlaybookRunRef, string, map[string]any) error {
	return fake.Err
}
func (fake *PlaybookProvider) ResolveApproval(context.Context, domain.ActorContext, ports.PlaybookRunRef, string, ports.ApprovalAction, map[string]string) error {
	return fake.Err
}
func (*PlaybookProvider) ListArtifacts(context.Context, domain.ActorContext, ports.PlaybookRunRef) ([]ports.ArtifactRef, error) {
	return nil, ErrNotConfigured
}
func (*PlaybookProvider) PreviewArtifact(context.Context, domain.ActorContext, ports.PlaybookRunRef, string) (ports.ArtifactPreview, error) {
	return ports.ArtifactPreview{}, ErrNotConfigured
}
func (*PlaybookProvider) DownloadArtifact(context.Context, domain.ActorContext, ports.PlaybookRunRef, string) (ports.ArtifactDownload, error) {
	return ports.ArtifactDownload{}, ErrNotConfigured
}

var (
	_ ports.AgentProvider     = (*AgentProvider)(nil)
	_ ports.KnowledgeProvider = (*KnowledgeProvider)(nil)
	_ ports.PlaybookProvider  = (*PlaybookProvider)(nil)
)
