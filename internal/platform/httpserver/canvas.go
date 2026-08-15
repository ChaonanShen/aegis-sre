package httpserver

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"

	canvasapp "github.com/1024XEngineer/aegis-sre/internal/application/canvas"
	"github.com/1024XEngineer/aegis-sre/internal/domain"
	"github.com/1024XEngineer/aegis-sre/internal/ports"
)

const maxCanvasJSONBytes int64 = 256 * 1024

func registerCanvasHandlers(mux *http.ServeMux, service *canvasapp.Service) {
	if service == nil {
		return
	}
	mux.HandleFunc("GET /api/v1/sessions/{session_id}/canvas", func(w http.ResponseWriter, request *http.Request) {
		projection, err := service.Get(request.Context(), actorFromRequest(request), domain.ID(request.PathValue("session_id")))
		if handleCanvasError(w, request, err) {
			return
		}
		writeCanvasProjection(w, projection)
	})
	mux.HandleFunc("PUT /api/v1/sessions/{session_id}/canvas", func(w http.ResponseWriter, request *http.Request) {
		revision, ok := parseCanvasRevision(request.Header.Get("If-Match"))
		if !ok {
			writeAPIProblem(w, request, http.StatusBadRequest, "invalid_argument", "If-Match must be a canvas revision", false)
			return
		}
		var body struct {
			Visible         bool                `json:"visible"`
			Layout          domain.CanvasLayout `json:"layout"`
			ActiveChartID   *domain.ID          `json:"active_chart_id"`
			OrderedChartIDs []domain.ID         `json:"ordered_chart_ids"`
		}
		if !decodeJSONBody(w, request, &body, maxCanvasJSONBytes) {
			return
		}
		active := domain.ID("")
		if body.ActiveChartID != nil {
			active = *body.ActiveChartID
		}
		projection, err := service.UpdateLayout(request.Context(), actorFromRequest(request), ports.UpdateCanvasInput{
			SessionID: domain.ID(request.PathValue("session_id")), ExpectedRevision: revision,
			Visible: body.Visible, Layout: body.Layout, ActiveChartID: active, OrderedChartIDs: body.OrderedChartIDs,
		})
		if handleCanvasError(w, request, err) {
			return
		}
		writeCanvasProjection(w, projection)
	})
}

func parseCanvasRevision(value string) (int64, bool) {
	value = strings.TrimSpace(value)
	if !strings.HasPrefix(value, `"canvas:`) || !strings.HasSuffix(value, `"`) {
		return 0, false
	}
	revision, err := strconv.ParseInt(strings.TrimSuffix(strings.TrimPrefix(value, `"canvas:`), `"`), 10, 64)
	return revision, err == nil && revision >= 0
}

func writeCanvasProjection(w http.ResponseWriter, projection domain.CanvasProjection) {
	if projection.Revision >= 0 {
		w.Header().Set("ETag", fmt.Sprintf(`"canvas:%d"`, projection.Revision))
	}
	writeJSON(w, http.StatusOK, canvasProjectionJSON(projection))
}

func canvasProjectionJSON(projection domain.CanvasProjection) map[string]any {
	items := make([]map[string]any, 0, len(projection.Items))
	for _, item := range projection.Items {
		items = append(items, map[string]any{
			"position": item.Position,
			"chart": map[string]any{
				"id": string(item.Chart.ID), "revision": item.Chart.Revision, "title": item.Chart.Title,
				"description": item.Chart.Description, "visualization": item.Chart.Visualization,
				"viz_config": json.RawMessage(item.Chart.VizConfig), "created_at": item.Chart.CreatedAt, "updated_at": item.Chart.UpdatedAt,
				"query": map[string]any{
					"id": string(item.Query.ID), "version": item.Query.Version, "datasource_uid": item.Query.DatasourceUID,
					"expression": item.Query.Expression, "range": map[string]any{"from": item.Query.From, "to": item.Query.To, "step_seconds": item.Query.StepSeconds}, "created_at": item.Query.CreatedAt,
				},
			},
		})
	}
	var active any
	if projection.ActiveChartID != "" {
		active = string(projection.ActiveChartID)
	}
	return map[string]any{"session_id": string(projection.SessionID), "visible": projection.Visible, "layout": projection.Layout, "active_chart_id": active, "revision": projection.Revision, "items": items, "created_at": projection.CreatedAt, "updated_at": projection.UpdatedAt}
}

func handleCanvasError(w http.ResponseWriter, request *http.Request, err error) bool {
	if err == nil {
		return false
	}
	status := http.StatusInternalServerError
	code := "internal"
	retryable := false
	var appErr *domain.AppError
	if errors.As(err, &appErr) {
		code, retryable = string(appErr.Code), appErr.Retryable
		switch appErr.Code {
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
		case domain.ErrorCapabilityUnavailable:
			status = http.StatusServiceUnavailable
		default:
			status = http.StatusInternalServerError
		}
	} else {
		status, code, retryable = http.StatusServiceUnavailable, "capability_unavailable", true
	}
	writeAPIProblem(w, request, status, code, "Canvas request failed", retryable)
	return true
}
