package ports

import (
	"context"
	"io"
	"time"

	"github.com/1024XEngineer/aegis-sre/internal/domain"
)

type PlaybookRef struct{ ID domain.ID }
type PlaybookRunRef struct {
	ID         domain.ID
	PlaybookID domain.ID
}

type PlaybookResource struct {
	Ref         PlaybookRef
	FolderUID   string
	Name        string
	Description string
	YAML        []byte
	Enabled     bool
	ReadOnly    bool
}

type ValidationIssue struct {
	Path    string `json:"path,omitempty"`
	Message string `json:"message"`
}

type CreatePlaybookInput struct {
	ID   domain.ID
	YAML []byte
}

type RunPlaybookInput struct {
	ID         domain.ID
	Parameters map[string]string
	Enqueue    bool
}

type PlaybookRunState struct {
	Ref        PlaybookRunRef
	Status     domain.RunStatus
	StartedAt  time.Time
	FinishedAt time.Time
	Steps      []PlaybookStepState
}

type PlaybookStepState struct {
	ID         string
	Name       string
	Status     domain.RunStatus
	StartedAt  time.Time
	FinishedAt time.Time
	HumanTask  map[string]any
	Approval   map[string]any
}

type ArtifactRef struct {
	Path      string
	Name      string
	MediaType string
	Size      int64
}

type ArtifactPreview struct {
	ArtifactRef
	Text      string
	Truncated bool
}

type ArtifactDownload struct {
	MediaType string
	Content   io.ReadCloser
}

type ApprovalAction string

const (
	ApprovalApprove ApprovalAction = "approve"
	ApprovalReject  ApprovalAction = "reject"
	ApprovalRewind  ApprovalAction = "rewind"
)

type PlaybookProvider interface {
	List(context.Context, domain.ActorContext, domain.PageRequest) (domain.Page[PlaybookResource], error)
	Get(context.Context, domain.ActorContext, PlaybookRef) (PlaybookResource, error)
	Create(context.Context, domain.ActorContext, CreatePlaybookInput) (PlaybookRef, error)
	Update(context.Context, domain.ActorContext, PlaybookRef, []byte) error
	Delete(context.Context, domain.ActorContext, PlaybookRef) error
	Validate(context.Context, domain.ActorContext, []byte) ([]ValidationIssue, error)
	StartRun(context.Context, domain.ActorContext, PlaybookRef, RunPlaybookInput) (PlaybookRunRef, error)
	ListRuns(context.Context, domain.ActorContext, PlaybookRef, domain.PageRequest) (domain.Page[PlaybookRunState], error)
	GetRun(context.Context, domain.ActorContext, PlaybookRunRef) (PlaybookRunState, error)
	CancelRun(context.Context, domain.ActorContext, PlaybookRunRef) error
	RetryRun(context.Context, domain.ActorContext, PlaybookRunRef, domain.ID) (PlaybookRunRef, error)
	StreamRun(context.Context, domain.ActorContext, PlaybookRunRef, int64) (EventStream, error)
	CompleteHumanTask(context.Context, domain.ActorContext, PlaybookRunRef, string, map[string]any) error
	ResolveApproval(context.Context, domain.ActorContext, PlaybookRunRef, string, ApprovalAction, map[string]string) error
	ListArtifacts(context.Context, domain.ActorContext, PlaybookRunRef) ([]ArtifactRef, error)
	PreviewArtifact(context.Context, domain.ActorContext, PlaybookRunRef, string) (ArtifactPreview, error)
	DownloadArtifact(context.Context, domain.ActorContext, PlaybookRunRef, string) (ArtifactDownload, error)
}
