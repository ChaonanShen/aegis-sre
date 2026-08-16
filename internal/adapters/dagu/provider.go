package dagu

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/1024XEngineer/aegis-sre/internal/domain"
	"github.com/1024XEngineer/aegis-sre/internal/ports"
	"gopkg.in/yaml.v3"
)

type Provider struct {
	client          *Client
	pollInterval    time.Duration
	legacyFolderUID string
}

type ProviderOption func(*Provider) error

func WithLegacyFolderUID(folderUID string) ProviderOption {
	return func(provider *Provider) error {
		if strings.TrimSpace(folderUID) == "" || len(folderUID) > 128 || strings.ContainsAny(folderUID, "\r\n\x00") {
			return errors.New("legacy Folder UID is invalid")
		}
		provider.legacyFolderUID = folderUID
		return nil
	}
}

func NewProvider(client *Client, options ...ProviderOption) (*Provider, error) {
	if client == nil {
		return nil, errors.New("Dagu client is required")
	}
	provider := &Provider{client: client, pollInterval: time.Second}
	for _, option := range options {
		if option != nil {
			if err := option(provider); err != nil {
				return nil, err
			}
		}
	}
	return provider, nil
}

func (provider *Provider) Check(ctx context.Context) error {
	_, err := provider.client.ListDAGs(ctx, 1, 1)
	return err
}

func (provider *Provider) List(ctx context.Context, actor domain.ActorContext, request domain.PageRequest) (domain.Page[ports.PlaybookResource], error) {
	limit := request.Limit
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	pageNumber, err := decodePageCursor(request.Cursor)
	if err != nil {
		return domain.Page[ports.PlaybookResource]{}, err
	}
	dagPage, err := provider.client.ListDAGs(ctx, pageNumber, limit)
	if err != nil {
		return domain.Page[ports.PlaybookResource]{}, err
	}
	items := make([]ports.PlaybookResource, 0, min(len(dagPage.DAGs), limit))
	for _, dag := range dagPage.DAGs {
		id, ok := playbookIDFromFileName(dag.FileName)
		if !ok {
			continue
		}
		status := labelsOwnershipStatus(dag.DAG.Labels, actor.FolderUID)
		current := domain.PlaybookIDInScope(id, actor) && status == ownershipMatches
		legacy := provider.legacyFolderUID == actor.FolderUID && domain.PlaybookIDInLegacyScope(id, actor) && status == ownershipMissing
		if !current && !legacy {
			continue
		}
		items = append(items, ports.PlaybookResource{
			Ref:         ports.PlaybookRef{ID: id},
			FolderUID:   actor.FolderUID,
			Name:        dag.DAG.Name,
			Description: dag.DAG.Description,
			Enabled:     !dag.Suspended,
		})
		if len(items) == limit {
			break
		}
	}
	hasMore := dagPage.TotalPages > 0 && pageNumber < dagPage.TotalPages
	nextCursor := ""
	if hasMore {
		nextCursor = encodePageCursor(pageNumber + 1)
	}
	return domain.Page[ports.PlaybookResource]{Items: items, NextCursor: nextCursor, HasMore: hasMore}, nil
}

func (provider *Provider) Get(ctx context.Context, actor domain.ActorContext, ref ports.PlaybookRef) (ports.PlaybookResource, error) {
	dag, err := provider.readablePlaybook(ctx, actor, ref)
	if err != nil {
		return ports.PlaybookResource{}, err
	}
	name, description := dagMetadata(dag.DAG, dag.Spec)
	return ports.PlaybookResource{Ref: ref, FolderUID: actor.FolderUID, Name: name, Description: description, YAML: []byte(dag.Spec), Enabled: !dag.Suspended}, nil
}

func (provider *Provider) Create(ctx context.Context, actor domain.ActorContext, input ports.CreatePlaybookInput) (ports.PlaybookRef, error) {
	dagName, err := playbookDAGName(input.ID)
	if err != nil {
		return ports.PlaybookRef{}, err
	}
	if len(bytes.TrimSpace(input.YAML)) == 0 {
		return ports.PlaybookRef{}, errors.New("playbook YAML is required")
	}
	bound, err := bindFolderOwnership(input.YAML, actor.FolderUID)
	if err != nil {
		return ports.PlaybookRef{}, err
	}
	if err := provider.client.CreateDAG(ctx, dagName, string(bound)); err != nil {
		if !isHTTPConflict(err) {
			return ports.PlaybookRef{}, err
		}
		// 相同幂等键会生成相同文件名；冲突时确认资源确实存在后返回原公开 ID。
		existing, getErr := provider.client.GetDAG(ctx, dagName)
		if getErr != nil {
			return ports.PlaybookRef{}, err
		}
		if !bytes.Equal(bytes.TrimSpace([]byte(existing.Spec)), bytes.TrimSpace(bound)) {
			return ports.PlaybookRef{}, err
		}
	}
	return ports.PlaybookRef{ID: input.ID}, nil
}

func (provider *Provider) Update(ctx context.Context, actor domain.ActorContext, ref ports.PlaybookRef, spec []byte) error {
	dagName, err := playbookDAGName(ref.ID)
	if err != nil {
		return err
	}
	if len(bytes.TrimSpace(spec)) == 0 {
		return errors.New("playbook YAML is required")
	}
	if _, err := provider.ownedPlaybook(ctx, actor, ref); err != nil {
		return err
	}
	bound, err := bindFolderOwnership(spec, actor.FolderUID)
	if err != nil {
		return err
	}
	return provider.client.UpdateDAG(ctx, dagName, string(bound))
}

func (provider *Provider) Delete(ctx context.Context, actor domain.ActorContext, ref ports.PlaybookRef) error {
	dagName, err := playbookDAGName(ref.ID)
	if err != nil {
		return err
	}
	if _, err := provider.ownedPlaybook(ctx, actor, ref); err != nil {
		return err
	}
	return provider.client.DeleteDAG(ctx, dagName)
}

func (provider *Provider) Validate(ctx context.Context, actor domain.ActorContext, spec []byte) ([]ports.ValidationIssue, error) {
	bound, err := bindFolderOwnership(spec, actor.FolderUID)
	if err != nil {
		return nil, err
	}
	result, err := provider.client.ValidateDAG(ctx, "aegis-validation", string(bound))
	if err != nil {
		return nil, err
	}
	issues := make([]ports.ValidationIssue, 0, len(result.Errors))
	for _, message := range result.Errors {
		issues = append(issues, ports.ValidationIssue{Message: message})
	}
	return issues, nil
}

func (provider *Provider) StartRun(ctx context.Context, actor domain.ActorContext, ref ports.PlaybookRef, input ports.RunPlaybookInput) (ports.PlaybookRunRef, error) {
	dagName, err := playbookDAGName(ref.ID)
	if err != nil {
		return ports.PlaybookRunRef{}, err
	}
	if err := requireIDPrefix(input.ID, "run_"); err != nil {
		return ports.PlaybookRunRef{}, err
	}
	if _, err := provider.ownedPlaybook(ctx, actor, ref); err != nil {
		return ports.PlaybookRunRef{}, err
	}
	runID, err := provider.client.StartDAG(ctx, dagName, string(ref.ID), string(input.ID), input.Parameters, input.Enqueue)
	if err != nil {
		if !isHTTPConflict(err) {
			return ports.PlaybookRunRef{}, err
		}
		// Dagu 已接受同一个 caller-supplied run ID 时，把重复请求视为同一次运行。
		existing, getErr := provider.client.FindRun(ctx, string(input.ID))
		if getErr != nil || existing.DAGRunID != string(input.ID) || !runBelongsToPlaybook(existing, ref.ID) {
			return ports.PlaybookRunRef{}, err
		}
		runID = existing.DAGRunID
	}
	if runID != string(input.ID) {
		return ports.PlaybookRunRef{}, errors.New("Dagu did not preserve the caller-supplied run ID")
	}
	return ports.PlaybookRunRef{ID: input.ID, PlaybookID: ref.ID}, nil
}

func (provider *Provider) ListRuns(ctx context.Context, actor domain.ActorContext, ref ports.PlaybookRef, request domain.PageRequest) (domain.Page[ports.PlaybookRunState], error) {
	if _, err := playbookDAGName(ref.ID); err != nil {
		return domain.Page[ports.PlaybookRunState]{}, err
	}
	if _, err := provider.readablePlaybook(ctx, actor, ref); err != nil {
		return domain.Page[ports.PlaybookRunState]{}, err
	}
	limit := request.Limit
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	start, err := decodeRunCursor(request.Cursor)
	if err != nil {
		return domain.Page[ports.PlaybookRunState]{}, err
	}
	labeledRuns, err := provider.client.ListRunsByLabel(ctx, playbookRunLabel(string(ref.ID)), start+limit+1)
	if err != nil {
		return domain.Page[ports.PlaybookRunState]{}, err
	}
	// 兼容旧版以 pbk_* 作为 Dagu Run 名称的历史记录。
	legacyRuns, err := provider.client.ListRuns(ctx, string(ref.ID), start+limit+1)
	if err != nil {
		return domain.Page[ports.PlaybookRunState]{}, err
	}
	runs := append(labeledRuns, legacyRuns...)
	sort.SliceStable(runs, func(i, j int) bool { return runs[i].StartedAt > runs[j].StartedAt })
	items := make([]ports.PlaybookRunState, 0, min(len(runs), limit+1))
	seen := make(map[string]struct{}, len(runs))
	for _, run := range runs {
		if !runBelongsToPlaybook(run, ref.ID) || requireIDPrefix(domain.ID(run.DAGRunID), "run_") != nil {
			continue
		}
		if _, exists := seen[run.DAGRunID]; exists {
			continue
		}
		seen[run.DAGRunID] = struct{}{}
		items = append(items, mapRun(ports.PlaybookRunRef{ID: domain.ID(run.DAGRunID), PlaybookID: ref.ID}, run))
	}
	if start >= len(items) {
		return domain.Page[ports.PlaybookRunState]{Items: []ports.PlaybookRunState{}}, nil
	}
	items = items[start:]
	hasMore := len(items) > limit
	if hasMore {
		items = items[:limit]
	}
	next := ""
	if hasMore {
		next = encodeRunCursor(start + len(items))
	}
	return domain.Page[ports.PlaybookRunState]{Items: items, NextCursor: next, HasMore: hasMore}, nil
}

func (provider *Provider) GetRun(ctx context.Context, actor domain.ActorContext, ref ports.PlaybookRunRef) (ports.PlaybookRunState, error) {
	resolved, summary, err := provider.resolveRun(ctx, actor, ref, true)
	if err != nil {
		return ports.PlaybookRunState{}, err
	}
	run, err := provider.client.GetRun(ctx, summary.Name, string(resolved.ID))
	if err != nil {
		return ports.PlaybookRunState{}, err
	}
	return mapRun(resolved, run), nil
}

func (provider *Provider) CancelRun(ctx context.Context, actor domain.ActorContext, ref ports.PlaybookRunRef) error {
	ref, run, err := provider.resolveRun(ctx, actor, ref, false)
	if err != nil {
		return err
	}
	return provider.client.StopRun(ctx, run.Name, string(ref.ID))
}

func (provider *Provider) RetryRun(ctx context.Context, actor domain.ActorContext, ref ports.PlaybookRunRef, newRunID domain.ID) (ports.PlaybookRunRef, error) {
	ref, run, err := provider.resolveRun(ctx, actor, ref, false)
	if err != nil {
		return ports.PlaybookRunRef{}, err
	}
	if err := requireIDPrefix(newRunID, "run_"); err != nil {
		return ports.PlaybookRunRef{}, err
	}
	if err := provider.client.RetryRun(ctx, run.Name, string(ref.ID), string(newRunID)); err != nil {
		if !isHTTPConflict(err) {
			return ports.PlaybookRunRef{}, err
		}
		existing, getErr := provider.client.FindRun(ctx, string(newRunID))
		if getErr != nil || existing.DAGRunID != string(newRunID) || !runBelongsToPlaybook(existing, ref.PlaybookID) {
			return ports.PlaybookRunRef{}, err
		}
	}
	return ports.PlaybookRunRef{ID: newRunID, PlaybookID: ref.PlaybookID}, nil
}

func (provider *Provider) StreamRun(ctx context.Context, actor domain.ActorContext, ref ports.PlaybookRunRef, after int64) (ports.EventStream, error) {
	resolved, _, err := provider.resolveRun(ctx, actor, ref, true)
	if err != nil {
		return nil, err
	}
	return &runEventStream{provider: provider, actor: actor, ref: resolved, sequence: after}, nil
}

func (provider *Provider) CompleteHumanTask(ctx context.Context, actor domain.ActorContext, ref ports.PlaybookRunRef, stepID string, input map[string]any) error {
	ref, run, err := provider.resolveRun(ctx, actor, ref, false)
	if err != nil {
		return err
	}
	return provider.client.CompleteHumanTask(ctx, run.Name, string(ref.ID), stepID, input)
}

func (provider *Provider) ResolveApproval(ctx context.Context, actor domain.ActorContext, ref ports.PlaybookRunRef, stepID string, action ports.ApprovalAction, input map[string]string) error {
	ref, run, err := provider.resolveRun(ctx, actor, ref, false)
	if err != nil {
		return err
	}
	if action != ports.ApprovalApprove && action != ports.ApprovalReject && action != ports.ApprovalRewind {
		return errors.New("unsupported approval action")
	}
	return provider.client.ResolveApproval(ctx, run.Name, string(ref.ID), stepID, string(action), input)
}

func (provider *Provider) ListArtifacts(ctx context.Context, actor domain.ActorContext, ref ports.PlaybookRunRef) ([]ports.ArtifactRef, error) {
	ref, run, err := provider.resolveRun(ctx, actor, ref, true)
	if err != nil {
		return nil, err
	}
	items, err := provider.client.ListArtifacts(ctx, run.Name, string(ref.ID))
	if err != nil {
		return nil, err
	}
	return flattenArtifacts(items), nil
}

func (provider *Provider) PreviewArtifact(ctx context.Context, actor domain.ActorContext, ref ports.PlaybookRunRef, artifactPath string) (ports.ArtifactPreview, error) {
	if err := validateArtifactPath(artifactPath); err != nil {
		return ports.ArtifactPreview{}, err
	}
	ref, run, err := provider.resolveRun(ctx, actor, ref, true)
	if err != nil {
		return ports.ArtifactPreview{}, err
	}
	preview, err := provider.client.PreviewArtifact(ctx, run.Name, string(ref.ID), artifactPath)
	if err != nil {
		return ports.ArtifactPreview{}, err
	}
	return ports.ArtifactPreview{ArtifactRef: ports.ArtifactRef{Path: preview.Path, Name: path.Base(preview.Path), MediaType: preview.MIMEType}, Text: preview.Content, Truncated: preview.Truncated}, nil
}

func (provider *Provider) DownloadArtifact(ctx context.Context, actor domain.ActorContext, ref ports.PlaybookRunRef, artifactPath string) (ports.ArtifactDownload, error) {
	if err := validateArtifactPath(artifactPath); err != nil {
		return ports.ArtifactDownload{}, err
	}
	ref, run, err := provider.resolveRun(ctx, actor, ref, true)
	if err != nil {
		return ports.ArtifactDownload{}, err
	}
	content, mediaType, err := provider.client.DownloadArtifact(ctx, run.Name, string(ref.ID), artifactPath)
	if err != nil {
		return ports.ArtifactDownload{}, err
	}
	return ports.ArtifactDownload{MediaType: mediaType, Content: io.NopCloser(bytes.NewReader(content))}, nil
}

type runEventStream struct {
	provider *Provider
	actor    domain.ActorContext
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
	state, err := stream.provider.GetRun(ctx, stream.actor, stream.ref)
	if err != nil {
		return domain.Event{}, err
	}
	stream.sequence++
	payloadValue := runStateJSON(state)
	payloadValue["sequence"] = stream.sequence
	payload, _ := json.Marshal(payloadValue)
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
				step := ports.PlaybookStepState{ID: stringValue(node.Step["id"]), Name: stringValue(node.Step["name"])}
				step.StartedAt, _ = time.Parse(time.RFC3339, node.StartedAt)
				step.FinishedAt, _ = time.Parse(time.RFC3339, node.FinishedAt)
				step.HumanTask, _ = node.Step["humanTask"].(map[string]any)
				step.Approval, _ = node.Step["approval"].(map[string]any)
				step.Status = mapStepStatus(node.StatusLabel, step.HumanTask, step.Approval)
				state.Steps = append(state.Steps, step)
			}
		}
	}
	if strings.EqualFold(run.StatusText, "waiting") {
		state.Status = waitingRunStatus(state.Steps)
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
	case "aborted", "cancelled", "canceled", "terminated":
		return domain.RunCancelled
	case "partially_succeeded", "rejected":
		return domain.RunFailed
	case "waiting_for_input", "waiting for input":
		return domain.RunWaitingForInput
	case "waiting", "waiting_for_approval", "waiting for approval":
		return domain.RunWaitingForApproval
	default:
		return domain.RunQueued
	}
}

func mapStepStatus(value string, humanTask, approval map[string]any) domain.RunStatus {
	if strings.EqualFold(value, "waiting") {
		if humanTask != nil {
			return domain.RunWaitingForInput
		}
		if approval != nil {
			return domain.RunWaitingForApproval
		}
	}
	switch strings.ToLower(value) {
	case "retrying":
		return domain.RunRunning
	case "skipped":
		return domain.RunSucceeded
	default:
		return mapRunStatus(value)
	}
}

func waitingRunStatus(steps []ports.PlaybookStepState) domain.RunStatus {
	for _, step := range steps {
		if step.Status == domain.RunWaitingForInput {
			return domain.RunWaitingForInput
		}
	}
	return domain.RunWaitingForApproval
}

func terminalRunStatus(status domain.RunStatus) bool {
	return status == domain.RunSucceeded || status == domain.RunFailed || status == domain.RunCancelled
}

// runStateJSON 生成可直接用于 REST 与 SSE 的完整公开快照，避免事件只携带状态导致客户端丢失步骤信息。
func runStateJSON(state ports.PlaybookRunState) map[string]any {
	steps := make([]map[string]any, 0, len(state.Steps))
	for _, step := range state.Steps {
		item := map[string]any{"id": step.ID, "name": step.Name, "status": step.Status}
		if !step.StartedAt.IsZero() {
			item["started_at"] = step.StartedAt
		}
		if !step.FinishedAt.IsZero() {
			item["ended_at"] = step.FinishedAt
		}
		if step.HumanTask != nil {
			item["human_task"] = step.HumanTask
		}
		if step.Approval != nil {
			item["approval"] = step.Approval
		}
		steps = append(steps, item)
	}
	value := map[string]any{"id": state.Ref.ID, "playbook_id": state.Ref.PlaybookID, "status": state.Status, "started_at": state.StartedAt, "updated_at": time.Now().UTC(), "steps": steps}
	if !state.FinishedAt.IsZero() {
		value["ended_at"] = state.FinishedAt
		value["updated_at"] = state.FinishedAt
	}
	return value
}

func playbookDAGName(id domain.ID) (string, error) {
	if err := requireIDPrefix(id, "pbk_"); err != nil {
		return "", err
	}
	return string(id), nil
}

func playbookIDFromFileName(fileName string) (domain.ID, bool) {
	if fileName == "" || path.Base(fileName) != fileName || strings.ContainsAny(fileName, "/\\") {
		return "", false
	}
	id := domain.ID(strings.TrimSuffix(fileName, ".yaml"))
	return id, requireIDPrefix(id, "pbk_") == nil
}

func encodePageCursor(page int) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.Itoa(page)))
}

func decodePageCursor(cursor string) (int, error) {
	if cursor == "" {
		return 1, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return 0, errors.New("invalid page cursor")
	}
	page, err := strconv.Atoi(string(decoded))
	if err != nil || page < 1 {
		return 0, errors.New("invalid page cursor")
	}
	return page, nil
}

func encodeRunCursor(offset int) string {
	return base64.RawURLEncoding.EncodeToString([]byte("run:" + strconv.Itoa(offset)))
}

func decodeRunCursor(cursor string) (int, error) {
	if cursor == "" {
		return 0, nil
	}
	decoded, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil || !strings.HasPrefix(string(decoded), "run:") {
		return 0, errors.New("invalid run cursor")
	}
	offset, err := strconv.Atoi(strings.TrimPrefix(string(decoded), "run:"))
	if err != nil || offset < 0 {
		return 0, errors.New("invalid run cursor")
	}
	return offset, nil
}

func dagMetadata(raw json.RawMessage, spec string) (string, string) {
	var summary struct {
		Name        string `json:"name"`
		Description string `json:"description"`
	}
	_ = json.Unmarshal(raw, &summary)
	if summary.Name != "" || summary.Description != "" {
		return summary.Name, summary.Description
	}
	var source struct {
		Name        string `yaml:"name"`
		Description string `yaml:"description"`
	}
	_ = yaml.Unmarshal([]byte(spec), &source)
	return source.Name, source.Description
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

func isHTTPConflict(err error) bool {
	var httpErr *HTTPError
	return errors.As(err, &httpErr) && httpErr.StatusCode == 409
}

func validateRunRef(ref ports.PlaybookRunRef) error {
	if err := requireIDPrefix(ref.PlaybookID, "pbk_"); err != nil {
		return err
	}
	return requireIDPrefix(ref.ID, "run_")
}

const playbookRunLabelKey = "aegis.playbook.id"

func playbookRunLabel(playbookID string) string {
	return playbookRunLabelKey + "=" + hex.EncodeToString([]byte(playbookID))
}

func playbookIDFromRun(run DAGRun) (domain.ID, bool) {
	prefix := playbookRunLabelKey + "="
	for _, label := range run.Labels {
		if !strings.HasPrefix(label, prefix) {
			continue
		}
		decoded, err := hex.DecodeString(strings.TrimPrefix(label, prefix))
		if err != nil {
			return "", false
		}
		id := domain.ID(decoded)
		return id, requireIDPrefix(id, "pbk_") == nil
	}
	// 旧版直接用公开 Playbook ID 作为 Dagu Run 名称。
	id := domain.ID(run.Name)
	return id, requireIDPrefix(id, "pbk_") == nil
}

func runBelongsToPlaybook(run DAGRun, playbookID domain.ID) bool {
	actual, ok := playbookIDFromRun(run)
	return ok && actual == playbookID
}

func (provider *Provider) resolveRun(ctx context.Context, actor domain.ActorContext, ref ports.PlaybookRunRef, allowLegacy bool) (ports.PlaybookRunRef, DAGRun, error) {
	if err := requireIDPrefix(ref.ID, "run_"); err != nil {
		return ports.PlaybookRunRef{}, DAGRun{}, err
	}
	if ref.PlaybookID != "" && requireIDPrefix(ref.PlaybookID, "pbk_") != nil {
		return ports.PlaybookRunRef{}, DAGRun{}, errors.New("invalid playbook identifier")
	}
	run, err := provider.client.FindRun(ctx, string(ref.ID))
	if err != nil {
		return ports.PlaybookRunRef{}, DAGRun{}, err
	}
	playbookID, ok := playbookIDFromRun(run)
	if !ok || (ref.PlaybookID != "" && ref.PlaybookID != playbookID) {
		return ports.PlaybookRunRef{}, DAGRun{}, errors.New("Dagu run does not belong to the requested Aegis playbook")
	}
	playbookRef := ports.PlaybookRef{ID: playbookID}
	var ownershipErr error
	if allowLegacy {
		_, ownershipErr = provider.readablePlaybook(ctx, actor, playbookRef)
	} else {
		_, ownershipErr = provider.ownedPlaybook(ctx, actor, playbookRef)
	}
	if ownershipErr != nil {
		return ports.PlaybookRunRef{}, DAGRun{}, ownershipErr
	}
	return ports.PlaybookRunRef{ID: ref.ID, PlaybookID: playbookID}, run, nil
}

// ownedPlaybook 以 Provider 原生数据作为 Folder ownership 的事实来源。
// 公共 ID 和可信请求 Folder 必须同时匹配 Dagu YAML labels；不匹配统一表现为资源不存在。
func (provider *Provider) ownedPlaybook(ctx context.Context, actor domain.ActorContext, ref ports.PlaybookRef) (DAGDetails, error) {
	dag, err := provider.loadPlaybook(ctx, actor, ref)
	if err != nil {
		return DAGDetails{}, err
	}
	if specOwnershipStatus(dag.Spec, actor.FolderUID) != ownershipMatches {
		return DAGDetails{}, ownershipNotFound()
	}
	return dag, nil
}

func (provider *Provider) readablePlaybook(ctx context.Context, actor domain.ActorContext, ref ports.PlaybookRef) (DAGDetails, error) {
	dag, err := provider.loadPlaybook(ctx, actor, ref)
	if err != nil {
		return DAGDetails{}, err
	}
	status := specOwnershipStatus(dag.Spec, actor.FolderUID)
	if status == ownershipMatches {
		return dag, nil
	}
	if status == ownershipMissing && provider.legacyFolderUID == actor.FolderUID && domain.PlaybookIDInLegacyScope(ref.ID, actor) {
		return dag, nil
	}
	return DAGDetails{}, ownershipNotFound()
}

func (provider *Provider) loadPlaybook(ctx context.Context, actor domain.ActorContext, ref ports.PlaybookRef) (DAGDetails, error) {
	dagName, err := playbookDAGName(ref.ID)
	if err != nil {
		return DAGDetails{}, err
	}
	if strings.TrimSpace(actor.FolderUID) == "" {
		return DAGDetails{}, ownershipNotFound()
	}
	dag, err := provider.client.GetDAG(ctx, dagName)
	if err != nil {
		return DAGDetails{}, err
	}
	return dag, nil
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
