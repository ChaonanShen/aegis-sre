package playbookmcp

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"

	"github.com/1024XEngineer/aegis-sre/internal/domain"
	"github.com/1024XEngineer/aegis-sre/internal/ports"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type Config struct {
	TokenFile  string
	TenantID   string
	OrgID      string
	UserID     string
	FolderUIDs []string
}

type service struct {
	provider ports.PlaybookProvider
	config   Config
	folders  map[string]struct{}
}

func NewHandler(provider ports.PlaybookProvider, config Config) (http.Handler, error) {
	if provider == nil || config.TokenFile == "" || config.TenantID == "" || config.OrgID == "" || config.UserID == "" || len(config.FolderUIDs) == 0 {
		return nil, errors.New("Playbook MCP requires provider, token, actor and Folder allowlist")
	}
	folders := make(map[string]struct{}, len(config.FolderUIDs))
	for _, folder := range config.FolderUIDs {
		folder = strings.TrimSpace(folder)
		if folder == "" {
			return nil, errors.New("Playbook MCP Folder allowlist contains an empty value")
		}
		folders[folder] = struct{}{}
	}
	svc := &service{provider: provider, config: config, folders: folders}
	server := mcp.NewServer(&mcp.Implementation{Name: "aegis-playbooks", Version: "1.0.0"}, nil)
	mcp.AddTool(server, &mcp.Tool{Name: "playbook.list", Description: "List authorized Playbooks."}, svc.list)
	mcp.AddTool(server, &mcp.Tool{Name: "playbook.validate", Description: "Validate a native Dagu YAML Playbook."}, svc.validate)
	mcp.AddTool(server, &mcp.Tool{Name: "playbook.start", Description: "Start an authorized Playbook with parameters."}, svc.start)
	mcp.AddTool(server, &mcp.Tool{Name: "playbook.get_run", Description: "Read the current state of an authorized Playbook Run."}, svc.getRun)
	streamable := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, nil)
	return bearerFile(config.TokenFile, streamable), nil
}

type listInput struct {
	FolderUID string `json:"folder_uid" jsonschema:"required,authorized Grafana Folder UID"`
	Cursor    string `json:"cursor,omitempty"`
	Limit     int    `json:"limit,omitempty" jsonschema:"maximum result count from 1 to 50"`
}

type playbookSummary struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
	Enabled     bool   `json:"enabled"`
}

type listOutput struct {
	Items      []playbookSummary `json:"items"`
	NextCursor string            `json:"next_cursor,omitempty"`
	HasMore    bool              `json:"has_more"`
}

func (svc *service) list(ctx context.Context, _ *mcp.CallToolRequest, input listInput) (*mcp.CallToolResult, listOutput, error) {
	actor, err := svc.actor(input.FolderUID)
	if err != nil {
		return nil, listOutput{}, err
	}
	if input.Limit < 0 || input.Limit > 50 {
		return nil, listOutput{}, toolError("invalid_argument")
	}
	page, err := svc.provider.List(ctx, actor, domain.PageRequest{Cursor: input.Cursor, Limit: input.Limit})
	if err != nil {
		return nil, listOutput{}, sanitize(err)
	}
	items := make([]playbookSummary, 0, len(page.Items))
	for _, item := range page.Items {
		items = append(items, playbookSummary{ID: string(item.Ref.ID), Name: item.Name, Description: item.Description, Enabled: item.Enabled})
	}
	return nil, listOutput{Items: items, NextCursor: page.NextCursor, HasMore: page.HasMore}, nil
}

type validateInput struct {
	FolderUID string `json:"folder_uid" jsonschema:"required,authorized Grafana Folder UID"`
	YAML      string `json:"yaml" jsonschema:"required,native Dagu YAML"`
}

type validateOutput struct {
	Valid  bool                    `json:"valid"`
	Errors []ports.ValidationIssue `json:"errors"`
}

func (svc *service) validate(ctx context.Context, _ *mcp.CallToolRequest, input validateInput) (*mcp.CallToolResult, validateOutput, error) {
	actor, err := svc.actor(input.FolderUID)
	if err != nil {
		return nil, validateOutput{}, err
	}
	if strings.TrimSpace(input.YAML) == "" || len(input.YAML) > 2<<20 {
		return nil, validateOutput{}, toolError("invalid_argument")
	}
	issues, err := svc.provider.Validate(ctx, actor, []byte(input.YAML))
	if err != nil {
		return nil, validateOutput{}, sanitize(err)
	}
	return nil, validateOutput{Valid: len(issues) == 0, Errors: issues}, nil
}

type startInput struct {
	FolderUID      string            `json:"folder_uid" jsonschema:"required,authorized Grafana Folder UID"`
	PlaybookID     string            `json:"playbook_id" jsonschema:"required,Aegis Playbook ID"`
	IdempotencyKey string            `json:"idempotency_key" jsonschema:"required,retry-safe key"`
	Parameters     map[string]string `json:"parameters,omitempty"`
}

type startOutput struct {
	RunID      string `json:"run_id"`
	PlaybookID string `json:"playbook_id"`
	Status     string `json:"status"`
}

func (svc *service) start(ctx context.Context, _ *mcp.CallToolRequest, input startInput) (*mcp.CallToolResult, startOutput, error) {
	actor, err := svc.actor(input.FolderUID)
	if err != nil {
		return nil, startOutput{}, err
	}
	playbookID := domain.ID(input.PlaybookID)
	if !playbookID.Valid() || !strings.HasPrefix(string(playbookID), "pbk_") || !domain.PlaybookIDInScope(playbookID, actor) || len(input.IdempotencyKey) < 8 || len(input.IdempotencyKey) > 128 {
		return nil, startOutput{}, toolError("invalid_argument")
	}
	runID := stableRunID(actor, playbookID, input.IdempotencyKey)
	runRef, err := svc.provider.StartRun(ctx, actor, ports.PlaybookRef{ID: playbookID}, ports.RunPlaybookInput{ID: runID, Parameters: input.Parameters})
	if err != nil {
		return nil, startOutput{}, sanitize(err)
	}
	return nil, startOutput{RunID: string(runRef.ID), PlaybookID: string(runRef.PlaybookID), Status: string(domain.RunQueued)}, nil
}

type getRunInput struct {
	FolderUID string `json:"folder_uid" jsonschema:"required,authorized Grafana Folder UID"`
	RunID     string `json:"run_id" jsonschema:"required,Aegis Run ID"`
}

type runOutput struct {
	RunID      string `json:"run_id"`
	PlaybookID string `json:"playbook_id"`
	Status     string `json:"status"`
}

func (svc *service) getRun(ctx context.Context, _ *mcp.CallToolRequest, input getRunInput) (*mcp.CallToolResult, runOutput, error) {
	actor, err := svc.actor(input.FolderUID)
	if err != nil {
		return nil, runOutput{}, err
	}
	runID := domain.ID(input.RunID)
	if !runID.Valid() || !strings.HasPrefix(string(runID), "run_") {
		return nil, runOutput{}, toolError("invalid_argument")
	}
	state, err := svc.provider.GetRun(ctx, actor, ports.PlaybookRunRef{ID: runID})
	if err != nil {
		return nil, runOutput{}, sanitize(err)
	}
	if !domain.PlaybookIDVisibleInScope(state.Ref.PlaybookID, actor) {
		return nil, runOutput{}, toolError("not_found")
	}
	return nil, runOutput{RunID: string(state.Ref.ID), PlaybookID: string(state.Ref.PlaybookID), Status: string(state.Status)}, nil
}

func (svc *service) actor(folderUID string) (domain.ActorContext, error) {
	if _, ok := svc.folders[folderUID]; !ok {
		return domain.ActorContext{}, toolError("forbidden")
	}
	return domain.ActorContext{TenantID: svc.config.TenantID, OrgID: svc.config.OrgID, UserID: svc.config.UserID, FolderUID: folderUID, Roles: []string{"Editor"}}, nil
}

func stableRunID(actor domain.ActorContext, playbookID domain.ID, key string) domain.ID {
	sum := sha256.Sum256([]byte("run\x00" + actor.TenantID + "\x00" + actor.OrgID + "\x00" + actor.UserID + "\x00" + string(playbookID) + "\x00" + key))
	return domain.ID("run_" + base64.RawURLEncoding.EncodeToString(sum[:18]))
}

func sanitize(err error) error {
	var appErr *domain.AppError
	if errors.As(err, &appErr) {
		switch appErr.Code {
		case domain.ErrorInvalidArgument, domain.ErrorForbidden, domain.ErrorNotFound, domain.ErrorConflict, domain.ErrorCapabilityUnavailable, domain.ErrorProviderTimeout, domain.ErrorProviderUnavailable, domain.ErrorProviderResultUnknown:
			return toolError(string(appErr.Code))
		}
	}
	return toolError("provider_unavailable")
}

func toolError(code string) error { return fmt.Errorf("playbook tool failed: %s", code) }

func bearerFile(path string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		content, err := os.ReadFile(path)
		expected := strings.TrimSpace(string(content))
		provided, ok := strings.CutPrefix(request.Header.Get("Authorization"), "Bearer ")
		if err != nil || expected == "" || !ok || len(provided) != len(expected) || subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) != 1 {
			w.Header().Set("WWW-Authenticate", "Bearer")
			http.Error(w, "unauthorized caller", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, request)
	})
}
