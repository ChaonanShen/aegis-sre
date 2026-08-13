package dagu

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"strings"
	"time"

	"github.com/1024XEngineer/aegis-sre/internal/domain"
	"github.com/1024XEngineer/aegis-sre/internal/ports"
)

type Provider struct {
	client       *Client
	pollInterval time.Duration
}

func NewProvider(client *Client) (*Provider, error) {
	if client == nil {
		return nil, errors.New("Dagu client is required")
	}
	return &Provider{client: client, pollInterval: time.Second}, nil
}

func (provider *Provider) List(ctx context.Context, _ domain.ActorContext, request domain.PageRequest) (domain.Page[ports.PlaybookResource], error) {
	limit := request.Limit
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	dags, err := provider.client.ListDAGs(ctx, 1, limit+1)
	if err != nil {
		return domain.Page[ports.PlaybookResource]{}, err
	}
	items := make([]ports.PlaybookResource, 0, min(len(dags), limit))
	for _, dag := range dags {
		id, ok := playbookIDFromFileName(dag.FileName)
		if !ok {
			continue
		}
		items = append(items, ports.PlaybookResource{
			Ref:         ports.PlaybookRef{ID: id},
			Name:        dag.DAG.Name,
			Description: dag.DAG.Description,
			Enabled:     !dag.Suspended,
		})
		if len(items) == limit {
			break
		}
	}
	return domain.Page[ports.PlaybookResource]{Items: items, HasMore: len(dags) > limit}, nil
}

func (provider *Provider) Get(ctx context.Context, _ domain.ActorContext, ref ports.PlaybookRef) (ports.PlaybookResource, error) {
	fileName, err := playbookFileName(ref.ID)
	if err != nil {
		return ports.PlaybookResource{}, err
	}
	dag, err := provider.client.GetDAG(ctx, fileName)
	if err != nil {
		return ports.PlaybookResource{}, err
	}
	return ports.PlaybookResource{Ref: ref, Name: string(ref.ID), YAML: []byte(dag.Spec), Enabled: !dag.Suspended}, nil
}

func (provider *Provider) Create(ctx context.Context, _ domain.ActorContext, input ports.CreatePlaybookInput) (ports.PlaybookRef, error) {
	fileName, err := playbookFileName(input.ID)
	if err != nil {
		return ports.PlaybookRef{}, err
	}
	if len(bytes.TrimSpace(input.YAML)) == 0 {
		return ports.PlaybookRef{}, errors.New("playbook YAML is required")
	}
	if err := provider.client.CreateDAG(ctx, strings.TrimSuffix(fileName, ".yaml"), string(input.YAML)); err != nil {
		return ports.PlaybookRef{}, err
	}
	return ports.PlaybookRef{ID: input.ID}, nil
}

func (provider *Provider) Update(ctx context.Context, _ domain.ActorContext, ref ports.PlaybookRef, spec []byte) error {
	fileName, err := playbookFileName(ref.ID)
	if err != nil {
		return err
	}
	if len(bytes.TrimSpace(spec)) == 0 {
		return errors.New("playbook YAML is required")
	}
	return provider.client.UpdateDAG(ctx, fileName, string(spec))
}

func (provider *Provider) Delete(ctx context.Context, _ domain.ActorContext, ref ports.PlaybookRef) error {
	fileName, err := playbookFileName(ref.ID)
	if err != nil {
		return err
	}
	return provider.client.DeleteDAG(ctx, fileName)
}

func (provider *Provider) Validate(ctx context.Context, _ domain.ActorContext, spec []byte) ([]ports.ValidationIssue, error) {
	result, err := provider.client.ValidateDAG(ctx, "aegis-validation", string(spec))
	if err != nil {
		return nil, err
	}
	issues := make([]ports.ValidationIssue, 0, len(result.Errors))
	for _, message := range result.Errors {
		issues = append(issues, ports.ValidationIssue{Message: message})
	}
	return issues, nil
}

func (provider *Provider) StartRun(ctx context.Context, _ domain.ActorContext, ref ports.PlaybookRef, input ports.RunPlaybookInput) (ports.PlaybookRunRef, error) {
	fileName, err := playbookFileName(ref.ID)
	if err != nil {
		return ports.PlaybookRunRef{}, err
	}
	if err := requireIDPrefix(input.ID, "run_"); err != nil {
		return ports.PlaybookRunRef{}, err
	}
	runID, err := provider.client.StartDAG(ctx, fileName, string(input.ID), input.Parameters, input.Enqueue)
	if err != nil {
		return ports.PlaybookRunRef{}, err
	}
	if runID != string(input.ID) {
		return ports.PlaybookRunRef{}, errors.New("Dagu did not preserve the caller-supplied run ID")
	}
	return ports.PlaybookRunRef{ID: input.ID, PlaybookID: ref.ID}, nil
}

func (provider *Provider) ListRuns(ctx context.Context, _ domain.ActorContext, ref ports.PlaybookRef, request domain.PageRequest) (domain.Page[ports.PlaybookRunState], error) {
	if _, err := playbookFileName(ref.ID); err != nil {
		return domain.Page[ports.PlaybookRunState]{}, err
	}
	limit := request.Limit
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	runs, err := provider.client.ListRuns(ctx, string(ref.ID), limit+1)
	if err != nil {
		return domain.Page[ports.PlaybookRunState]{}, err
	}
	items := make([]ports.PlaybookRunState, 0, min(len(runs), limit+1))
	for _, run := range runs {
		if run.Name != string(ref.ID) || requireIDPrefix(domain.ID(run.DAGRunID), "run_") != nil {
			continue
		}
		items = append(items, mapRun(ports.PlaybookRunRef{ID: domain.ID(run.DAGRunID), PlaybookID: ref.ID}, run))
	}
	hasMore := len(items) > limit
	if hasMore {
		items = items[:limit]
	}
	return domain.Page[ports.PlaybookRunState]{Items: items, HasMore: hasMore}, nil
}

func (provider *Provider) GetRun(ctx context.Context, _ domain.ActorContext, ref ports.PlaybookRunRef) (ports.PlaybookRunState, error) {
	resolved, err := provider.resolveRunRef(ctx, ref)
	if err != nil {
		return ports.PlaybookRunState{}, err
	}
	run, err := provider.client.GetRun(ctx, string(resolved.PlaybookID), string(resolved.ID))
	if err != nil {
		return ports.PlaybookRunState{}, err
	}
	return mapRun(resolved, run), nil
}

func (provider *Provider) CancelRun(ctx context.Context, _ domain.ActorContext, ref ports.PlaybookRunRef) error {
	ref, err := provider.resolveRunRef(ctx, ref)
	if err != nil {
		return err
	}
	return provider.client.StopRun(ctx, string(ref.PlaybookID), string(ref.ID))
}

func (provider *Provider) RetryRun(ctx context.Context, _ domain.ActorContext, ref ports.PlaybookRunRef, newRunID domain.ID) (ports.PlaybookRunRef, error) {
	ref, err := provider.resolveRunRef(ctx, ref)
	if err != nil {
		return ports.PlaybookRunRef{}, err
	}
	if err := requireIDPrefix(newRunID, "run_"); err != nil {
		return ports.PlaybookRunRef{}, err
	}
	if err := provider.client.RetryRun(ctx, string(ref.PlaybookID), string(ref.ID), string(newRunID)); err != nil {
		return ports.PlaybookRunRef{}, err
	}
	return ports.PlaybookRunRef{ID: newRunID, PlaybookID: ref.PlaybookID}, nil
}

func (provider *Provider) StreamRun(_ context.Context, _ domain.ActorContext, ref ports.PlaybookRunRef, after int64) (ports.EventStream, error) {
	if err := requireIDPrefix(ref.ID, "run_"); err != nil {
		return nil, err
	}
	return &runEventStream{provider: provider, ref: ref, sequence: after}, nil
}

func (provider *Provider) CompleteHumanTask(ctx context.Context, _ domain.ActorContext, ref ports.PlaybookRunRef, stepID string, input map[string]any) error {
	ref, err := provider.resolveRunRef(ctx, ref)
	if err != nil {
		return err
	}
	return provider.client.CompleteHumanTask(ctx, string(ref.PlaybookID), string(ref.ID), stepID, input)
}

func (provider *Provider) ResolveApproval(ctx context.Context, _ domain.ActorContext, ref ports.PlaybookRunRef, stepID string, action ports.ApprovalAction, input map[string]string) error {
	ref, err := provider.resolveRunRef(ctx, ref)
	if err != nil {
		return err
	}
	if action != ports.ApprovalApprove && action != ports.ApprovalReject && action != ports.ApprovalRewind {
		return errors.New("unsupported approval action")
	}
	return provider.client.ResolveApproval(ctx, string(ref.PlaybookID), string(ref.ID), stepID, string(action), input)
}

func (provider *Provider) ListArtifacts(ctx context.Context, _ domain.ActorContext, ref ports.PlaybookRunRef) ([]ports.ArtifactRef, error) {
	ref, err := provider.resolveRunRef(ctx, ref)
	if err != nil {
		return nil, err
	}
	items, err := provider.client.ListArtifacts(ctx, string(ref.PlaybookID), string(ref.ID))
	if err != nil {
		return nil, err
	}
	return flattenArtifacts(items), nil
}

func (provider *Provider) PreviewArtifact(ctx context.Context, _ domain.ActorContext, ref ports.PlaybookRunRef, artifactPath string) (ports.ArtifactPreview, error) {
	if err := validateArtifactPath(artifactPath); err != nil {
		return ports.ArtifactPreview{}, err
	}
	ref, err := provider.resolveRunRef(ctx, ref)
	if err != nil {
		return ports.ArtifactPreview{}, err
	}
	preview, err := provider.client.PreviewArtifact(ctx, string(ref.PlaybookID), string(ref.ID), artifactPath)
	if err != nil {
		return ports.ArtifactPreview{}, err
	}
	return ports.ArtifactPreview{ArtifactRef: ports.ArtifactRef{Path: preview.Path, Name: path.Base(preview.Path), MediaType: preview.MIMEType}, Text: preview.Content, Truncated: preview.Truncated}, nil
}

func (provider *Provider) DownloadArtifact(ctx context.Context, _ domain.ActorContext, ref ports.PlaybookRunRef, artifactPath string) (ports.ArtifactDownload, error) {
	if err := validateArtifactPath(artifactPath); err != nil {
		return ports.ArtifactDownload{}, err
	}
	ref, err := provider.resolveRunRef(ctx, ref)
	if err != nil {
		return ports.ArtifactDownload{}, err
	}
	content, mediaType, err := provider.client.DownloadArtifact(ctx, string(ref.PlaybookID), string(ref.ID), artifactPath)
	if err != nil {
		return ports.ArtifactDownload{}, err
	}
	return ports.ArtifactDownload{MediaType: mediaType, Content: io.NopCloser(bytes.NewReader(content))}, nil
}

type runEventStream struct {
	provider *Provider
	ref      ports.PlaybookRunRef
	sequence int64
	closed   bool
}

func (stream *runEventStream) Next(ctx context.Context) (domain.Event, error) {
	if stream.closed {
		return domain.Event{}, io.EOF
	}
	if stream.sequence > 0 {
		timer := time.NewTimer(stream.provider.pollInterval)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return domain.Event{}, ctx.Err()
		case <-timer.C:
		}
	}
	state, err := stream.provider.GetRun(ctx, domain.ActorContext{}, stream.ref)
	if err != nil {
		return domain.Event{}, err
	}
	stream.sequence++
	payload, _ := json.Marshal(map[string]string{"status": string(state.Status)})
	event := domain.Event{ID: domain.ID(fmt.Sprintf("evt_%s_%d", stream.ref.ID, stream.sequence)), Type: domain.EventRunUpdated, RunID: stream.ref.ID, Sequence: stream.sequence, OccurredAt: time.Now().UTC(), Payload: payload}
	if terminalRunStatus(state.Status) {
		stream.closed = true
	}
	return event, nil
}

func (stream *runEventStream) Close() error { stream.closed = true; return nil }

func mapRun(ref ports.PlaybookRunRef, run DAGRun) ports.PlaybookRunState {
	state := ports.PlaybookRunState{Ref: ref, Status: mapRunStatus(run.StatusText)}
	state.StartedAt, _ = time.Parse(time.RFC3339, run.StartedAt)
	state.FinishedAt, _ = time.Parse(time.RFC3339, run.FinishedAt)
	if len(run.Nodes) > 0 {
		var nodes []struct {
			StatusLabel string         `json:"statusLabel"`
			StartedAt   string         `json:"startedAt"`
			FinishedAt  string         `json:"finishedAt"`
			Step        map[string]any `json:"step"`
		}
		if json.Unmarshal(run.Nodes, &nodes) == nil {
			for _, node := range nodes {
				step := ports.PlaybookStepState{ID: stringValue(node.Step["id"]), Name: stringValue(node.Step["name"]), Status: mapRunStatus(node.StatusLabel)}
				step.StartedAt, _ = time.Parse(time.RFC3339, node.StartedAt)
				step.FinishedAt, _ = time.Parse(time.RFC3339, node.FinishedAt)
				step.HumanTask, _ = node.Step["humanTask"].(map[string]any)
				step.Approval, _ = node.Step["approval"].(map[string]any)
				state.Steps = append(state.Steps, step)
			}
		}
	}
	return state
}

func mapRunStatus(value string) domain.RunStatus {
	switch strings.ToLower(value) {
	case "running":
		return domain.RunRunning
	case "queued", "not started", "not_started":
		return domain.RunQueued
	case "success", "succeeded":
		return domain.RunSucceeded
	case "failed", "error":
		return domain.RunFailed
	case "cancelled", "canceled", "terminated":
		return domain.RunCancelled
	case "waiting", "waiting_for_approval", "waiting for approval":
		return domain.RunWaitingForApproval
	default:
		return domain.RunQueued
	}
}

func terminalRunStatus(status domain.RunStatus) bool {
	return status == domain.RunSucceeded || status == domain.RunFailed || status == domain.RunCancelled
}

func playbookFileName(id domain.ID) (string, error) {
	if err := requireIDPrefix(id, "pbk_"); err != nil {
		return "", err
	}
	return string(id) + ".yaml", nil
}

func playbookIDFromFileName(fileName string) (domain.ID, bool) {
	if !strings.HasSuffix(fileName, ".yaml") {
		return "", false
	}
	id := domain.ID(strings.TrimSuffix(fileName, ".yaml"))
	return id, requireIDPrefix(id, "pbk_") == nil
}

func requireIDPrefix(id domain.ID, prefix string) error {
	if !strings.HasPrefix(string(id), prefix) {
		return fmt.Errorf("identifier must use %s prefix", prefix)
	}
	if !id.Valid() {
		return errors.New("invalid public identifier")
	}
	return nil
}

func validateRunRef(ref ports.PlaybookRunRef) error {
	if err := requireIDPrefix(ref.PlaybookID, "pbk_"); err != nil {
		return err
	}
	return requireIDPrefix(ref.ID, "run_")
}

func (provider *Provider) resolveRunRef(ctx context.Context, ref ports.PlaybookRunRef) (ports.PlaybookRunRef, error) {
	if err := requireIDPrefix(ref.ID, "run_"); err != nil {
		return ports.PlaybookRunRef{}, err
	}
	if ref.PlaybookID != "" {
		if err := requireIDPrefix(ref.PlaybookID, "pbk_"); err != nil {
			return ports.PlaybookRunRef{}, err
		}
		return ref, nil
	}
	run, err := provider.client.FindRun(ctx, string(ref.ID))
	if err != nil {
		return ports.PlaybookRunRef{}, err
	}
	playbookID := domain.ID(run.Name)
	if err := requireIDPrefix(playbookID, "pbk_"); err != nil {
		return ports.PlaybookRunRef{}, errors.New("Dagu run does not belong to an Aegis playbook")
	}
	return ports.PlaybookRunRef{ID: ref.ID, PlaybookID: playbookID}, nil
}

func validateArtifactPath(value string) error {
	clean := path.Clean(value)
	if value == "" || clean == "." || clean != value || strings.HasPrefix(clean, "/") || strings.HasPrefix(clean, "../") {
		return errors.New("invalid artifact path")
	}
	return nil
}

func flattenArtifacts(items []Artifact) []ports.ArtifactRef {
	var output []ports.ArtifactRef
	for _, item := range items {
		if len(item.Children) == 0 && item.Path != "" {
			output = append(output, ports.ArtifactRef{Path: item.Path, Name: item.Name, MediaType: item.Type, Size: item.Size})
		}
		output = append(output, flattenArtifacts(item.Children)...)
	}
	return output
}

func stringValue(value any) string {
	text, _ := value.(string)
	return text
}

var _ ports.PlaybookProvider = (*Provider)(nil)
