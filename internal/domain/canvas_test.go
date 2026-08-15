package domain

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func validQueryChartSpec() QueryChartSpec {
	return QueryChartSpec{
		DatasourceUID: "prom-main",
		Expression:    "rate(http_requests_total[5m])",
		From:          time.Date(2026, 8, 15, 0, 0, 0, 0, time.UTC),
		To:            time.Date(2026, 8, 15, 1, 0, 0, 0, time.UTC),
		StepSeconds:   30,
		Title:         "HTTP request rate",
		Visualization: "timeseries",
		VizConfig:     json.RawMessage(`{"kind":"VizConfig","group":"timeseries","version":"v1","spec":{"options":{},"fieldConfig":{"defaults":{},"overrides":[]}}}`),
	}
}

func TestNormalizeQueryChartSpecCanonicalizesPersistableDefinition(t *testing.T) {
	input := validQueryChartSpec()
	input.DatasourceUID = " prom-main "
	input.Expression = " rate(up[5m]) "
	input.Title = " Availability "
	input.From = input.From.In(time.FixedZone("offset", 8*60*60))

	got, err := NormalizeQueryChartSpec(input)
	if err != nil {
		t.Fatal(err)
	}
	if got.DatasourceUID != "prom-main" || got.Expression != "rate(up[5m])" || got.Title != "Availability" {
		t.Fatalf("normalized = %+v", got)
	}
	if got.From.Location() != time.UTC || string(got.VizConfig) != `{"group":"timeseries","kind":"VizConfig","spec":{"fieldConfig":{"defaults":{},"overrides":[]},"options":{}},"version":"v1"}` {
		t.Fatalf("canonical values = from %s, viz %s", got.From, got.VizConfig)
	}
}

func TestNormalizeQueryChartSpecRejectsUnsafeOrUnboundedDefinitions(t *testing.T) {
	tests := map[string]func(*QueryChartSpec){
		"missing datasource": func(value *QueryChartSpec) { value.DatasourceUID = "" },
		"missing expression": func(value *QueryChartSpec) { value.Expression = "" },
		"instant range":      func(value *QueryChartSpec) { value.To = value.From },
		"too broad":          func(value *QueryChartSpec) { value.To = value.From.Add(MaxQueryRange + time.Second) },
		"too many points": func(value *QueryChartSpec) {
			value.To = value.From.Add(4 * time.Hour)
			value.StepSeconds = 1
		},
		"invalid step":      func(value *QueryChartSpec) { value.StepSeconds = 0 },
		"unsupported chart": func(value *QueryChartSpec) { value.Visualization = "stat" },
		"large PromQL":      func(value *QueryChartSpec) { value.Expression = strings.Repeat("x", MaxPromQLBytes+1) },
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			value := validQueryChartSpec()
			mutate(&value)
			if _, err := NormalizeQueryChartSpec(value); err == nil {
				t.Fatal("invalid definition accepted")
			}
		})
	}
}

func TestNormalizeVizConfigRejectsResultsCredentialsAndUnknownEnvelope(t *testing.T) {
	tests := map[string]string{
		"samples":    `{"kind":"VizConfig","group":"timeseries","version":"v1","spec":{"options":{"samples":[]},"fieldConfig":{}}}`,
		"token":      `{"kind":"VizConfig","group":"timeseries","version":"v1","spec":{"options":{"token":"secret"},"fieldConfig":{}}}`,
		"targets":    `{"kind":"VizConfig","group":"timeseries","version":"v1","spec":{"options":{},"fieldConfig":{},"targets":[]}}`,
		"extra root": `{"kind":"VizConfig","group":"timeseries","version":"v1","spec":{"options":{},"fieldConfig":{}},"query":{}}`,
		"trailing":   `{"kind":"VizConfig","group":"timeseries","version":"v1","spec":{"options":{},"fieldConfig":{}}}{}`,
	}
	for name, raw := range tests {
		t.Run(name, func(t *testing.T) {
			if _, err := NormalizeVizConfig(json.RawMessage(raw)); err == nil {
				t.Fatal("unsafe VizConfig accepted")
			}
		})
	}
}

func TestCanvasLayoutsAreExplicit(t *testing.T) {
	for _, layout := range []CanvasLayout{CanvasGrid2x2, CanvasGrid3x2, CanvasFlex} {
		if !layout.Valid() {
			t.Fatalf("layout %q rejected", layout)
		}
	}
	if CanvasLayout("freeform").Valid() {
		t.Fatal("unknown layout accepted")
	}
}
