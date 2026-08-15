package domain

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	MaxCanvasCharts       = 20
	MaxDatasourceUIDBytes = 512
	MaxPromQLBytes        = 16 * 1024
	MaxChartTitleRunes    = 1024
	MaxChartDescRunes     = 4096
	MaxVizConfigBytes     = 128 * 1024
	MaxQueryPoints        = 11_000
	MaxQueryRange         = 31 * 24 * time.Hour
)

type CanvasLayout string

const (
	CanvasGrid2x2 CanvasLayout = "grid-2x2"
	CanvasGrid3x2 CanvasLayout = "grid-3x2"
	CanvasFlex    CanvasLayout = "flex"
)

func (layout CanvasLayout) Valid() bool {
	return layout == CanvasGrid2x2 || layout == CanvasGrid3x2 || layout == CanvasFlex
}

type QueryDefinition struct {
	ID            ID
	Version       int64
	DatasourceUID string
	Expression    string
	From          time.Time
	To            time.Time
	StepSeconds   int64
	CreatedAt     time.Time
}

type ChartDefinition struct {
	ID            ID
	Revision      int64
	QueryID       ID
	QueryVersion  int64
	Title         string
	Description   string
	Visualization string
	VizConfig     json.RawMessage
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

type CanvasItem struct {
	Chart    ChartDefinition
	Query    QueryDefinition
	Position int
}

type CanvasProjection struct {
	SessionID     ID
	Visible       bool
	Layout        CanvasLayout
	ActiveChartID ID
	Revision      int64
	Items         []CanvasItem
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

type QueryChartSpec struct {
	DatasourceUID string
	Expression    string
	From          time.Time
	To            time.Time
	StepSeconds   int64
	Title         string
	Description   string
	Visualization string
	VizConfig     json.RawMessage
}

func NormalizeQueryChartSpec(value QueryChartSpec) (QueryChartSpec, error) {
	value.DatasourceUID = strings.TrimSpace(value.DatasourceUID)
	value.Expression = strings.TrimSpace(value.Expression)
	value.Title = strings.TrimSpace(value.Title)
	value.Description = strings.TrimSpace(value.Description)
	value.Visualization = strings.TrimSpace(strings.ToLower(value.Visualization))
	value.From = value.From.UTC()
	value.To = value.To.UTC()
	if value.DatasourceUID == "" || len(value.DatasourceUID) > MaxDatasourceUIDBytes {
		return QueryChartSpec{}, errors.New("datasource UID is required and exceeds its limit")
	}
	if value.Expression == "" || len(value.Expression) > MaxPromQLBytes {
		return QueryChartSpec{}, errors.New("PromQL is required and exceeds its limit")
	}
	if value.Title == "" || utf8.RuneCountInString(value.Title) > MaxChartTitleRunes || utf8.RuneCountInString(value.Description) > MaxChartDescRunes {
		return QueryChartSpec{}, errors.New("chart metadata is invalid")
	}
	if value.Visualization != "timeseries" {
		return QueryChartSpec{}, errors.New("only timeseries visualization is supported")
	}
	if value.From.IsZero() || value.To.IsZero() || !value.To.After(value.From) || value.To.Sub(value.From) > MaxQueryRange {
		return QueryChartSpec{}, errors.New("query requires an increasing absolute range within 31 days")
	}
	if value.StepSeconds <= 0 || value.StepSeconds > 86_400 {
		return QueryChartSpec{}, errors.New("query step is invalid")
	}
	points := (value.To.Unix()-value.From.Unix())/value.StepSeconds + 1
	if points > MaxQueryPoints {
		return QueryChartSpec{}, errors.New("query exceeds the point limit")
	}
	canonical, err := NormalizeVizConfig(value.VizConfig)
	if err != nil {
		return QueryChartSpec{}, err
	}
	value.VizConfig = canonical
	return value, nil
}

func NormalizeVizConfig(raw json.RawMessage) (json.RawMessage, error) {
	if len(raw) == 0 || len(raw) > MaxVizConfigBytes {
		return nil, errors.New("VizConfig is required and exceeds its limit")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, fmt.Errorf("decode VizConfig: %w", err)
	}
	if err := ensureJSONEOF(decoder); err != nil {
		return nil, err
	}
	root, ok := value.(map[string]any)
	if !ok || len(root) != 4 || root["kind"] != "VizConfig" {
		return nil, errors.New("VizConfig envelope is invalid")
	}
	for _, key := range []string{"group", "version"} {
		text, ok := root[key].(string)
		if !ok || strings.TrimSpace(text) == "" {
			return nil, errors.New("VizConfig group and version are required")
		}
	}
	spec, ok := root["spec"].(map[string]any)
	if !ok || len(spec) != 2 {
		return nil, errors.New("VizConfig spec is invalid")
	}
	if _, ok := spec["options"].(map[string]any); !ok {
		return nil, errors.New("VizConfig options are required")
	}
	if _, ok := spec["fieldConfig"].(map[string]any); !ok {
		return nil, errors.New("VizConfig fieldConfig is required")
	}
	limits := jsonLimits{forbidden: map[string]struct{}{
		"targets": {}, "frames": {}, "series": {}, "samples": {}, "url": {},
		"token": {}, "password": {}, "authorization": {}, "html": {},
	}}
	if err := limits.visit(value, 1); err != nil {
		return nil, err
	}
	canonical, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("encode VizConfig: %w", err)
	}
	return canonical, nil
}

type jsonLimits struct {
	nodes     int
	forbidden map[string]struct{}
}

func (limits *jsonLimits) visit(value any, depth int) error {
	limits.nodes++
	if depth > 12 || limits.nodes > 2048 {
		return errors.New("VizConfig structure exceeds its limit")
	}
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			if _, blocked := limits.forbidden[strings.ToLower(key)]; blocked {
				return fmt.Errorf("VizConfig field %q is forbidden", key)
			}
			if err := limits.visit(child, depth+1); err != nil {
				return err
			}
		}
	case []any:
		if len(typed) > 128 {
			return errors.New("VizConfig array exceeds its limit")
		}
		for _, child := range typed {
			if err := limits.visit(child, depth+1); err != nil {
				return err
			}
		}
	}
	return nil
}

func ensureJSONEOF(decoder *json.Decoder) error {
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		if err == nil {
			return errors.New("VizConfig contains trailing JSON")
		}
		return fmt.Errorf("decode trailing VizConfig: %w", err)
	}
	return nil
}
