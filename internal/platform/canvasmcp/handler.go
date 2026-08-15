package canvasmcp

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/1024XEngineer/aegis-sre/internal/adapters/canvassqlite"
	canvasapp "github.com/1024XEngineer/aegis-sre/internal/application/canvas"
	"github.com/1024XEngineer/aegis-sre/internal/domain"
	"github.com/1024XEngineer/aegis-sre/internal/ports"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type Config struct {
	TokenFile string
	TenantID  string
	OrgID     string
	UserID    string
}

func NewHandler(service *canvasapp.Service, config Config) (http.Handler, error) {
	if service == nil || config.TokenFile == "" || config.TenantID == "" || config.OrgID == "" || config.UserID == "" {
		return nil, errors.New("Canvas MCP requires service, token and actor")
	}
	svc := &handler{service: service, actor: domain.ActorContext{TenantID: config.TenantID, OrgID: config.OrgID, UserID: config.UserID}}
	server := mcp.NewServer(&mcp.Implementation{Name: "aegis-canvas", Version: "1.0.0"}, nil)
	mcp.AddTool(server, &mcp.Tool{Name: "canvas.publish_query_chart", Description: `Persist a bounded Prometheus range query and its Canvas chart definition for an Agent session. viz_config MUST be a VizConfig envelope: {"kind":"VizConfig","group":"timeseries","version":"v1","spec":{"options":{},"fieldConfig":{}}}. Put legend and tooltip in spec.options and field settings in spec.fieldConfig; top-level Grafana panel options are invalid.`}, svc.publish)
	streamable := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, nil)
	return bearerFile(config.TokenFile, streamable), nil
}

type publishInput struct {
	SessionID     string         `json:"session_id" jsonschema:"required,public Agent session ID"`
	OperationID   string         `json:"operation_id" jsonschema:"required,stable retry-safe operation key"`
	DatasourceUID string         `json:"datasource_uid" jsonschema:"required,Prometheus datasource UID"`
	Expression    string         `json:"expression" jsonschema:"required,PromQL range expression"`
	From          time.Time      `json:"from" jsonschema:"required,absolute UTC start time"`
	To            time.Time      `json:"to" jsonschema:"required,absolute UTC end time"`
	StepSeconds   int64          `json:"step_seconds" jsonschema:"required,range query step"`
	Title         string         `json:"title" jsonschema:"required,chart title"`
	Description   string         `json:"description,omitempty"`
	Visualization string         `json:"visualization" jsonschema:"required,timeseries only"`
	VizConfig     map[string]any `json:"viz_config" jsonschema:"required,Canvas-safe Grafana visualization config"`
}

type publishOutput struct {
	ChartID        string `json:"chart_id"`
	CanvasRevision int64  `json:"canvas_revision"`
}

func (svc *handler) publish(ctx context.Context, _ *mcp.CallToolRequest, input publishInput) (*mcp.CallToolResult, publishOutput, error) {
	sessionID := domain.ID(strings.TrimSpace(input.SessionID))
	if !sessionID.Valid() || !strings.HasPrefix(string(sessionID), "ses_") || len(input.OperationID) < 8 || len(input.OperationID) > 128 {
		return nil, publishOutput{}, toolError("invalid_argument")
	}
	if input.From.Location() == nil || input.To.Location() == nil || input.From.IsZero() || input.To.IsZero() || !input.From.Equal(input.From.UTC()) || !input.To.Equal(input.To.UTC()) {
		return nil, publishOutput{}, toolError("invalid_argument")
	}
	encoded, err := json.Marshal(input.VizConfig)
	if err != nil {
		return nil, publishOutput{}, toolError("invalid_argument")
	}
	spec := domain.QueryChartSpec{DatasourceUID: input.DatasourceUID, Expression: input.Expression, From: input.From, To: input.To, StepSeconds: input.StepSeconds, Title: input.Title, Description: input.Description, Visualization: input.Visualization, VizConfig: encoded}
	hash, err := canvassqlite.StableRequestHash(spec)
	if err != nil {
		return nil, publishOutput{}, toolError("invalid_argument")
	}
	projection, err := svc.service.PublishQueryChart(ctx, svc.actor, ports.PublishQueryChartInput{SessionID: sessionID, OperationID: input.OperationID, RequestHash: hash, Spec: spec})
	if err != nil {
		return nil, publishOutput{}, sanitize(err)
	}
	if projection.ActiveChartID == "" {
		return nil, publishOutput{}, toolError("internal")
	}
	return nil, publishOutput{ChartID: string(projection.ActiveChartID), CanvasRevision: projection.Revision}, nil
}

type handler struct {
	service *canvasapp.Service
	actor   domain.ActorContext
}

func toolError(code string) error { return fmt.Errorf("Canvas tool failed: %s", code) }

func sanitize(err error) error {
	var appErr *domain.AppError
	if errors.As(err, &appErr) {
		return toolError(string(appErr.Code))
	}
	return toolError("provider_unavailable")
}

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
