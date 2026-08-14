package httpserver

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/1024XEngineer/aegis-sre/internal/domain"
	"github.com/1024XEngineer/aegis-sre/internal/ports"
)

const maxPlaybookYAMLBytes int64 = 2 << 20

func registerPlaybookHandlers(mux *http.ServeMux, provider ports.PlaybookProvider) {
	if provider == nil {
		return
	}
	mux.HandleFunc("GET /api/v1/playbooks", func(w http.ResponseWriter, request *http.Request) {
		actor, ok := requirePlaybookActor(w, request, false)
		if !ok {
			return
		}
		limit, _ := strconv.Atoi(request.URL.Query().Get("limit"))
		page, err := provider.List(request.Context(), actor, domain.PageRequest{Cursor: request.URL.Query().Get("cursor"), Limit: limit})
		if handleProviderError(w, request, err) {
			return
		}
		items := make([]any, 0, len(page.Items))
		for _, item := range page.Items {
			items = append(items, playbookSummaryJSON(item))
		}
		response := map[string]any{"items": items, "has_more": page.HasMore}
		if page.NextCursor != "" {
			response["next_cursor"] = page.NextCursor
		}
		writeJSON(w, http.StatusOK, response)
	})
	mux.HandleFunc("POST /api/v1/playbooks", func(w http.ResponseWriter, request *http.Request) {
		actor, allowed := requirePlaybookActor(w, request, true)
		if !allowed {
			return
		}
		key, ok := requireIdempotencyKey(w, request)
		if !ok {
			return
		}
		spec, ok := readLimitedBody(w, request, maxPlaybookYAMLBytes)
		if !ok {
			return
		}
		id := scopedPlaybookID(actor, key)
		ref, err := provider.Create(request.Context(), actor, ports.CreatePlaybookInput{ID: id, YAML: spec})
		if handleProviderError(w, request, err) {
			return
		}
		resource, err := provider.Get(request.Context(), actor, ref)
		if handleProviderError(w, request, err) {
			return
		}
		writeJSON(w, http.StatusCreated, playbookJSON(resource))
	})
	mux.HandleFunc("GET /api/v1/playbooks/{playbook_id}", func(w http.ResponseWriter, request *http.Request) {
		actor, allowed := requirePlaybookActor(w, request, false)
		if !allowed {
			return
		}
		ref, ok := scopedPlaybookRef(w, request, actor)
		if !ok {
			return
		}
		resource, err := provider.Get(request.Context(), actor, ref)
		if handleProviderError(w, request, err) {
			return
		}
		writeJSON(w, http.StatusOK, playbookJSON(resource))
	})
	mux.HandleFunc("PUT /api/v1/playbooks/{playbook_id}", func(w http.ResponseWriter, request *http.Request) {
		actor, allowed := requirePlaybookActor(w, request, true)
		if !allowed {
			return
		}
		ref, ok := scopedPlaybookRef(w, request, actor)
		if !ok {
			return
		}
		spec, ok := readLimitedBody(w, request, maxPlaybookYAMLBytes)
		if !ok {
			return
		}
		if err := provider.Update(request.Context(), actor, ref, spec); handleProviderError(w, request, err) {
			return
		}
		resource, err := provider.Get(request.Context(), actor, ref)
		if handleProviderError(w, request, err) {
			return
		}
		writeJSON(w, http.StatusOK, playbookJSON(resource))
	})
	mux.HandleFunc("DELETE /api/v1/playbooks/{playbook_id}", func(w http.ResponseWriter, request *http.Request) {
		actor, allowed := requirePlaybookActor(w, request, true)
		if !allowed {
			return
		}
		ref, ok := scopedPlaybookRef(w, request, actor)
		if !ok {
			return
		}
		if err := provider.Delete(request.Context(), actor, ref); handleProviderError(w, request, err) {
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("POST /api/v1/playbooks/{playbook_id}/validate", func(w http.ResponseWriter, request *http.Request) {
		actor, allowed := requirePlaybookActor(w, request, true)
		if !allowed {
			return
		}
		if _, ok := scopedPlaybookRef(w, request, actor); !ok {
			return
		}
		spec, ok := readLimitedBody(w, request, maxPlaybookYAMLBytes)
		if !ok {
			return
		}
		issues, err := provider.Validate(request.Context(), actor, spec)
		if handleProviderError(w, request, err) {
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"valid": len(issues) == 0, "errors": issues})
	})
	mux.HandleFunc("POST /api/v1/playbooks/validate", func(w http.ResponseWriter, request *http.Request) {
		actor, allowed := requirePlaybookActor(w, request, true)
		if !allowed {
			return
		}
		spec, ok := readLimitedBody(w, request, maxPlaybookYAMLBytes)
		if !ok {
			return
		}
		issues, err := provider.Validate(request.Context(), actor, spec)
		if handleProviderError(w, request, err) {
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"valid": len(issues) == 0, "errors": issues})
	})
	mux.HandleFunc("POST /api/v1/playbooks/{playbook_id}/runs", func(w http.ResponseWriter, request *http.Request) {
		actor, allowed := requirePlaybookActor(w, request, true)
		if !allowed {
			return
		}
		ref, ok := scopedPlaybookRef(w, request, actor)
		if !ok {
			return
		}
		key, ok := requireIdempotencyKey(w, request)
		if !ok {
			return
		}
		var input struct {
			Parameters map[string]string `json:"parameters"`
		}
		if !decodeJSONBody(w, request, &input, 1<<20) {
			return
		}
		runID := stableRunID(actor, ref.ID, key)
		runRef, err := provider.StartRun(request.Context(), actor, ref, ports.RunPlaybookInput{ID: runID, Parameters: input.Parameters})
		if handleProviderError(w, request, err) {
			return
		}
		writeJSON(w, http.StatusAccepted, queuedRunJSON(runRef))
	})
	mux.HandleFunc("GET /api/v1/playbooks/{playbook_id}/runs", func(w http.ResponseWriter, request *http.Request) {
		actor, allowed := requirePlaybookActor(w, request, false)
		if !allowed {
			return
		}
		ref, ok := scopedPlaybookRef(w, request, actor)
		if !ok {
			return
		}
		limit, _ := strconv.Atoi(request.URL.Query().Get("limit"))
		page, err := provider.ListRuns(request.Context(), actor, ref, domain.PageRequest{Cursor: request.URL.Query().Get("cursor"), Limit: limit})
		if handleProviderError(w, request, err) {
			return
		}
		items := make([]any, 0, len(page.Items))
		for _, item := range page.Items {
			items = append(items, runJSON(item))
		}
		response := map[string]any{"items": items, "has_more": page.HasMore}
		if page.NextCursor != "" {
			response["next_cursor"] = page.NextCursor
		}
		writeJSON(w, http.StatusOK, response)
	})
	mux.HandleFunc("GET /api/v1/runs/{run_id}", func(w http.ResponseWriter, request *http.Request) {
		_, state, ok := scopedRunState(w, request, provider, false)
		if !ok {
			return
		}
		writeJSON(w, http.StatusOK, runJSON(state))
	})
	mux.HandleFunc("POST /api/v1/runs/{run_action}", func(w http.ResponseWriter, request *http.Request) {
		segment := request.PathValue("run_action")
		runID, action, ok := strings.Cut(segment, ":")
		if !ok || (action != "cancel" && action != "retry") {
			writeAPIProblem(w, request, http.StatusNotFound, "not_found", "run action not found", false)
			return
		}
		request.SetPathValue("run_id", runID)
		actor, state, valid := scopedRunState(w, request, provider, true)
		if !valid {
			return
		}
		ref := state.Ref
		if action == "cancel" {
			if err := provider.CancelRun(request.Context(), actor, ref); handleProviderError(w, request, err) {
				return
			}
			w.WriteHeader(http.StatusNoContent)
			return
		}
		key, valid := requireIdempotencyKey(w, request)
		if !valid {
			return
		}
		newRef, err := provider.RetryRun(request.Context(), actor, ref, stableRunID(actor, ref.PlaybookID, key))
		if handleProviderError(w, request, err) {
			return
		}
		writeJSON(w, http.StatusAccepted, queuedRunJSON(newRef))
	})
	mux.HandleFunc("GET /api/v1/runs/{run_id}/events", func(w http.ResponseWriter, request *http.Request) {
		actor, state, ok := scopedRunState(w, request, provider, false)
		if !ok {
			return
		}
		after, _ := strconv.ParseInt(request.URL.Query().Get("after_sequence"), 10, 64)
		stream, err := provider.StreamRun(request.Context(), actor, state.Ref, after)
		if handleProviderError(w, request, err) {
			return
		}
		defer stream.Close()
		streamSSE(w, request, stream)
	})
	mux.HandleFunc("POST /api/v1/runs/{run_id}/human-tasks/{step_action}", func(w http.ResponseWriter, request *http.Request) {
		stepID, action, found := strings.Cut(request.PathValue("step_action"), ":")
		if !found || action != "complete" {
			writeAPIProblem(w, request, http.StatusNotFound, "not_found", "human task action not found", false)
			return
		}
		request.SetPathValue("step_id", stepID)
		actor, state, ok := scopedRunState(w, request, provider, true)
		if !ok || !requireStepID(w, request) || !requireIdempotencyHeader(w, request) {
			return
		}
		var input map[string]any
		if !decodeJSONBody(w, request, &input, 1<<20) {
			return
		}
		if err := provider.CompleteHumanTask(request.Context(), actor, state.Ref, request.PathValue("step_id"), input); handleProviderError(w, request, err) {
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("POST /api/v1/runs/{run_id}/approvals/{step_action}", func(w http.ResponseWriter, request *http.Request) {
		stepID, action, found := strings.Cut(request.PathValue("step_action"), ":")
		if !found || action != "resolve" {
			writeAPIProblem(w, request, http.StatusNotFound, "not_found", "approval action not found", false)
			return
		}
		request.SetPathValue("step_id", stepID)
		actor, state, ok := scopedRunState(w, request, provider, true)
		if !ok || !requireStepID(w, request) || !requireIdempotencyHeader(w, request) {
			return
		}
		var input struct {
			Decision ports.ApprovalAction `json:"decision"`
			Inputs   map[string]string    `json:"inputs"`
		}
		if !decodeJSONBody(w, request, &input, 1<<20) {
			return
		}
		if err := provider.ResolveApproval(request.Context(), actor, state.Ref, request.PathValue("step_id"), input.Decision, input.Inputs); handleProviderError(w, request, err) {
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("GET /api/v1/runs/{run_id}/artifacts", func(w http.ResponseWriter, request *http.Request) {
		actor, state, ok := scopedRunState(w, request, provider, false)
		if !ok {
			return
		}
		items, err := provider.ListArtifacts(request.Context(), actor, state.Ref)
		if handleProviderError(w, request, err) {
			return
		}
		projected := make([]map[string]any, 0, len(items))
		for _, item := range items {
			projected = append(projected, artifactJSON(item))
		}
		writeJSON(w, http.StatusOK, map[string]any{"items": projected})
	})
	mux.HandleFunc("GET /api/v1/runs/{run_id}/artifacts/preview", func(w http.ResponseWriter, request *http.Request) {
		actor, state, ok := scopedRunState(w, request, provider, false)
		if !ok {
			return
		}
		preview, err := provider.PreviewArtifact(request.Context(), actor, state.Ref, request.URL.Query().Get("path"))
		if handleProviderError(w, request, err) {
			return
		}
		writeJSON(w, http.StatusOK, artifactPreviewJSON(preview))
	})
	mux.HandleFunc("GET /api/v1/runs/{run_id}/artifacts/download", func(w http.ResponseWriter, request *http.Request) {
		actor, state, ok := scopedRunState(w, request, provider, false)
		if !ok {
			return
		}
		download, err := provider.DownloadArtifact(request.Context(), actor, state.Ref, request.URL.Query().Get("path"))
		if handleProviderError(w, request, err) {
			return
		}
		defer download.Content.Close()
		w.Header().Set("Content-Type", download.MediaType)
		w.Header().Set("Cache-Control", "no-store")
		_, _ = io.Copy(w, download.Content)
	})
}

func actorFromRequest(request *http.Request) domain.ActorContext {
	roles := strings.FieldsFunc(request.Header.Get("X-Aegis-Roles"), func(r rune) bool { return r == ',' || r == ';' })
	return domain.ActorContext{TenantID: request.Header.Get(headerTenantID), OrgID: request.Header.Get(headerOrgID), UserID: request.Header.Get(headerUserID), FolderUID: request.Header.Get("X-Aegis-Folder-UID"), Roles: roles}
}

func requirePlaybookActor(w http.ResponseWriter, request *http.Request, write bool) (domain.ActorContext, bool) {
	actor := actorFromRequest(request)
	if err := actor.Validate(); err != nil {
		writeAPIProblem(w, request, http.StatusUnauthorized, "unauthenticated", "Grafana identity is required", false)
		return domain.ActorContext{}, false
	}
	if write && !hasPlaybookWriteRole(actor.Roles) {
		writeAPIProblem(w, request, http.StatusForbidden, "forbidden", "Grafana Editor or Admin role is required", false)
		return domain.ActorContext{}, false
	}
	return actor, true
}

func hasPlaybookWriteRole(roles []string) bool {
	for _, role := range roles {
		if strings.EqualFold(strings.TrimSpace(role), "Editor") || strings.EqualFold(strings.TrimSpace(role), "Admin") {
			return true
		}
	}
	return false
}

func scopedPlaybookRef(w http.ResponseWriter, request *http.Request, actor domain.ActorContext) (ports.PlaybookRef, bool) {
	ref, ok := playbookRef(w, request)
	if !ok {
		return ports.PlaybookRef{}, false
	}
	if !domain.PlaybookIDInScope(ref.ID, actor) {
		writeAPIProblem(w, request, http.StatusNotFound, "not_found", "playbook not found", false)
		return ports.PlaybookRef{}, false
	}
	return ref, true
}

func playbookRef(w http.ResponseWriter, request *http.Request) (ports.PlaybookRef, bool) {
	id := domain.ID(request.PathValue("playbook_id"))
	if !id.Valid() || !strings.HasPrefix(string(id), "pbk_") {
		writeAPIProblem(w, request, http.StatusBadRequest, "invalid_argument", "invalid playbook ID", false)
		return ports.PlaybookRef{}, false
	}
	return ports.PlaybookRef{ID: id}, true
}

func runRef(w http.ResponseWriter, request *http.Request) (ports.PlaybookRunRef, bool) {
	id := domain.ID(request.PathValue("run_id"))
	if !id.Valid() || !strings.HasPrefix(string(id), "run_") {
		writeAPIProblem(w, request, http.StatusBadRequest, "invalid_argument", "invalid run ID", false)
		return ports.PlaybookRunRef{}, false
	}
	return ports.PlaybookRunRef{ID: id}, true
}

// Run URL 只有公共 run ID，必须先向 Provider 解析所属 playbook，再校验 Grafana 组织范围。
func scopedRunState(w http.ResponseWriter, request *http.Request, provider ports.PlaybookProvider, write bool) (domain.ActorContext, ports.PlaybookRunState, bool) {
	actor, allowed := requirePlaybookActor(w, request, write)
	if !allowed {
		return domain.ActorContext{}, ports.PlaybookRunState{}, false
	}
	ref, ok := runRef(w, request)
	if !ok {
		return domain.ActorContext{}, ports.PlaybookRunState{}, false
	}
	state, err := provider.GetRun(request.Context(), actor, ref)
	if handleProviderError(w, request, err) {
		return domain.ActorContext{}, ports.PlaybookRunState{}, false
	}
	if !domain.PlaybookIDInScope(state.Ref.PlaybookID, actor) {
		writeAPIProblem(w, request, http.StatusNotFound, "not_found", "run not found", false)
		return domain.ActorContext{}, ports.PlaybookRunState{}, false
	}
	return actor, state, true
}

func requireStepID(w http.ResponseWriter, request *http.Request) bool {
	value := request.PathValue("step_id")
	if value == "" || len(value) > 128 || strings.ContainsAny(value, "/\\\r\n\x00") {
		writeAPIProblem(w, request, http.StatusBadRequest, "invalid_argument", "invalid step ID", false)
		return false
	}
	return true
}

func requireIdempotencyHeader(w http.ResponseWriter, request *http.Request) bool {
	_, ok := requireIdempotencyKey(w, request)
	return ok
}

func requireIdempotencyKey(w http.ResponseWriter, request *http.Request) (string, bool) {
	value := safeID(request.Header.Get("Idempotency-Key"))
	if len(value) < 8 {
		writeAPIProblem(w, request, http.StatusBadRequest, "invalid_argument", "valid Idempotency-Key is required", false)
		return "", false
	}
	return value, true
}

func stableRunID(actor domain.ActorContext, playbookID domain.ID, key string) domain.ID {
	sum := sha256.Sum256([]byte("run\x00" + actor.TenantID + "\x00" + actor.OrgID + "\x00" + actor.UserID + "\x00" + string(playbookID) + "\x00" + key))
	return domain.ID("run_" + base64.RawURLEncoding.EncodeToString(sum[:18]))
}

func scopedPlaybookID(actor domain.ActorContext, key string) domain.ID {
	sum := sha256.Sum256([]byte("pbk\x00" + actor.TenantID + "\x00" + actor.OrgID + "\x00" + actor.UserID + "\x00" + key))
	return domain.ID("pbk_" + domain.PlaybookScopeKey(actor) + "_" + base64.RawURLEncoding.EncodeToString(sum[:18]))
}

func readLimitedBody(w http.ResponseWriter, request *http.Request, limit int64) ([]byte, bool) {
	content, err := io.ReadAll(io.LimitReader(request.Body, limit+1))
	if err != nil || int64(len(content)) > limit {
		writeAPIProblem(w, request, http.StatusBadRequest, "invalid_argument", "request body is invalid or too large", false)
		return nil, false
	}
	if len(strings.TrimSpace(string(content))) == 0 {
		writeAPIProblem(w, request, http.StatusBadRequest, "invalid_argument", "request body is required", false)
		return nil, false
	}
	return content, true
}

func decodeJSONBody(w http.ResponseWriter, request *http.Request, output any, limit int64) bool {
	content, ok := readLimitedBody(w, request, limit)
	if !ok {
		return false
	}
	decoder := json.NewDecoder(strings.NewReader(string(content)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		writeAPIProblem(w, request, http.StatusBadRequest, "invalid_argument", "invalid JSON request", false)
		return false
	}
	return true
}

func playbookJSON(resource ports.PlaybookResource) map[string]any {
	value := playbookSummaryJSON(resource)
	if len(resource.YAML) > 0 {
		value["source"] = string(resource.YAML)
	}
	return value
}

func playbookSummaryJSON(resource ports.PlaybookResource) map[string]any {
	value := map[string]any{"id": resource.Ref.ID, "name": resource.Name, "description": resource.Description, "status": "disabled"}
	if resource.Enabled {
		value["status"] = "active"
	}
	return value
}

func queuedRunJSON(ref ports.PlaybookRunRef) map[string]any {
	now := time.Now().UTC()
	return map[string]any{"id": ref.ID, "playbook_id": ref.PlaybookID, "status": domain.RunQueued, "sequence": 0, "started_at": now, "updated_at": now, "steps": []any{}}
}

func runJSON(state ports.PlaybookRunState) map[string]any {
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
	started := state.StartedAt
	if started.IsZero() {
		started = time.Now().UTC()
	}
	value := map[string]any{"id": state.Ref.ID, "playbook_id": state.Ref.PlaybookID, "status": state.Status, "sequence": 0, "started_at": started, "updated_at": time.Now().UTC(), "steps": steps}
	if !state.FinishedAt.IsZero() {
		value["ended_at"] = state.FinishedAt
		value["updated_at"] = state.FinishedAt
	}
	return value
}

func artifactJSON(artifact ports.ArtifactRef) map[string]any {
	return map[string]any{
		"name":       artifact.Name,
		"path":       artifact.Path,
		"media_type": artifact.MediaType,
		"size":       artifact.Size,
	}
}

func artifactPreviewJSON(preview ports.ArtifactPreview) map[string]any {
	value := artifactJSON(preview.ArtifactRef)
	value["text"] = preview.Text
	value["truncated"] = preview.Truncated
	return value
}

func streamSSE(w http.ResponseWriter, request *http.Request, stream ports.EventStream) {
	if stream == nil {
		writeAPIProblem(w, request, http.StatusBadGateway, "provider_result_unknown", "provider returned no event stream", false)
		return
	}
	defer stream.Close()
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeAPIProblem(w, request, http.StatusInternalServerError, "internal", "streaming is unavailable", false)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Accel-Buffering", "no")
	for {
		event, err := stream.Next(request.Context())
		if errors.Is(err, io.EOF) || errors.Is(err, context.Canceled) {
			return
		}
		if err != nil {
			return
		}
		envelope := map[string]any{"event_id": event.ID, "event_type": event.Type, "sequence": event.Sequence, "occurred_at": event.OccurredAt, "payload": json.RawMessage(event.Payload)}
		if event.RunID != "" {
			envelope["run_id"] = event.RunID
		}
		if event.SessionID != "" {
			envelope["session_id"] = event.SessionID
		}
		if event.TurnID != "" {
			envelope["turn_id"] = event.TurnID
		}
		content, _ := json.Marshal(envelope)
		_, _ = fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", event.Sequence, event.Type, content)
		flusher.Flush()
	}
}

type providerHTTPError interface {
	HTTPStatus() int
	CanRetry() bool
}

func handleProviderError(w http.ResponseWriter, request *http.Request, err error) bool {
	if err == nil {
		return false
	}
	status := http.StatusBadGateway
	code := "provider_unavailable"
	retryable := true
	var appError *domain.AppError
	if errors.As(err, &appError) {
		code, retryable = string(appError.Code), appError.Retryable
		switch appError.Code {
		case domain.ErrorInvalidArgument:
			status = http.StatusBadRequest
		case domain.ErrorUnauthenticated:
			status = http.StatusUnauthorized
		case domain.ErrorForbidden:
			status = http.StatusForbidden
		case domain.ErrorNotFound:
			status = http.StatusNotFound
		case domain.ErrorConflict:
			status = http.StatusConflict
		case domain.ErrorProviderTimeout:
			status = http.StatusGatewayTimeout
		case domain.ErrorCapabilityUnavailable:
			status = http.StatusServiceUnavailable
		case domain.ErrorProviderUnavailable, domain.ErrorProviderResultUnknown:
			status = http.StatusBadGateway
		default:
			status, code, retryable = http.StatusInternalServerError, "internal", false
		}
	} else {
		var httpError providerHTTPError
		if errors.As(err, &httpError) {
			status = httpError.HTTPStatus()
			retryable = httpError.CanRetry()
			switch status {
			case http.StatusBadRequest:
				code, retryable = "invalid_argument", false
			case http.StatusUnauthorized:
				code, retryable = "provider_unavailable", false
			case http.StatusForbidden:
				code, retryable = "forbidden", false
			case http.StatusNotFound:
				code, retryable = "not_found", false
			case http.StatusConflict:
				code, retryable = "conflict", false
			default:
				status = http.StatusBadGateway
			}
		} else if errors.Is(err, context.DeadlineExceeded) {
			status, code, retryable = http.StatusGatewayTimeout, "provider_timeout", true
		} else if strings.Contains(err.Error(), "invalid") || strings.Contains(err.Error(), "required") || strings.Contains(err.Error(), "unsupported") {
			status, code, retryable = http.StatusBadRequest, "invalid_argument", false
		}
	}
	writeAPIProblem(w, request, status, code, "provider request failed", retryable)
	return true
}
