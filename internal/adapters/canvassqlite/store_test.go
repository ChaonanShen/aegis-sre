package canvassqlite

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/1024XEngineer/aegis-sre/internal/domain"
	"github.com/1024XEngineer/aegis-sre/internal/ports"
)

var testActor = domain.ActorContext{TenantID: "tenant-a", OrgID: "org-a", UserID: "user-a"}
var testSessionID = domain.ID("ses_0123456789")

func testSpec() domain.QueryChartSpec {
	return domain.QueryChartSpec{
		DatasourceUID: "prom-main", Expression: "rate(http_requests_total[5m])",
		From: time.Date(2026, 8, 15, 0, 0, 0, 0, time.UTC), To: time.Date(2026, 8, 15, 1, 0, 0, 0, time.UTC), StepSeconds: 30,
		Title: "Request rate", Visualization: "timeseries",
		VizConfig: json.RawMessage(`{"kind":"VizConfig","group":"timeseries","version":"v1","spec":{"options":{},"fieldConfig":{"defaults":{},"overrides":[]}}}`),
	}
}

func openTestStore(t *testing.T) (*Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "canvas.db")
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store, path
}

func publishInput(t *testing.T, operation string) ports.PublishQueryChartInput {
	t.Helper()
	spec := testSpec()
	hash, err := StableRequestHash(spec)
	if err != nil {
		t.Fatal(err)
	}
	return ports.PublishQueryChartInput{SessionID: testSessionID, OperationID: operation, RequestHash: hash, Spec: spec}
}

func TestStoreMigratesPublishesAndReopensProjection(t *testing.T) {
	store, path := openTestStore(t)
	store.now = func() time.Time { return time.Date(2026, 8, 15, 2, 0, 0, 0, time.UTC) }
	created, err := store.PublishQueryChart(context.Background(), testActor, publishInput(t, "publish-0001"))
	if err != nil {
		t.Fatal(err)
	}
	if created.Revision != 1 || !created.Visible || created.ActiveChartID == "" || len(created.Items) != 1 {
		t.Fatalf("created = %+v", created)
	}
	if created.Items[0].Query.Expression != testSpec().Expression || created.Items[0].Chart.QueryID != created.Items[0].Query.ID {
		t.Fatalf("item = %+v", created.Items[0])
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	restored, err := reopened.Get(context.Background(), testActor, testSessionID)
	if err != nil || restored.Revision != created.Revision || restored.Items[0].Chart.ID != created.Items[0].Chart.ID {
		t.Fatalf("restored = %+v, err = %v", restored, err)
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("database permissions = %v, err = %v", info.Mode().Perm(), err)
	}
}

func TestPublishIsIdempotentAndRejectsChangedPayload(t *testing.T) {
	store, _ := openTestStore(t)
	input := publishInput(t, "publish-0002")
	first, err := store.PublishQueryChart(context.Background(), testActor, input)
	if err != nil {
		t.Fatal(err)
	}
	second, err := store.PublishQueryChart(context.Background(), testActor, input)
	if err != nil || second.Revision != first.Revision || second.Items[0].Chart.ID != first.Items[0].Chart.ID {
		t.Fatalf("second = %+v, err = %v", second, err)
	}
	input.RequestHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	if _, err := store.PublishQueryChart(context.Background(), testActor, input); appCode(err) != domain.ErrorConflict {
		t.Fatalf("conflict error = %v", err)
	}
}

func TestUpdateLayoutReordersDeletesAndRejectsStaleRevision(t *testing.T) {
	store, _ := openTestStore(t)
	first, _ := store.PublishQueryChart(context.Background(), testActor, publishInput(t, "publish-0003"))
	second, _ := store.PublishQueryChart(context.Background(), testActor, publishInput(t, "publish-0004"))
	updated, err := store.UpdateLayout(context.Background(), testActor, ports.UpdateCanvasInput{
		SessionID: testSessionID, ExpectedRevision: second.Revision, Visible: true, Layout: domain.CanvasFlex,
		ActiveChartID: first.Items[0].Chart.ID, OrderedChartIDs: []domain.ID{second.Items[1].Chart.ID, first.Items[0].Chart.ID},
	})
	if err != nil || updated.Revision != second.Revision+1 || updated.Items[0].Chart.ID != second.Items[1].Chart.ID {
		t.Fatalf("updated = %+v, err = %v", updated, err)
	}
	trimmed, err := store.UpdateLayout(context.Background(), testActor, ports.UpdateCanvasInput{
		SessionID: testSessionID, ExpectedRevision: updated.Revision, Visible: true, Layout: domain.CanvasGrid2x2,
		ActiveChartID: first.Items[0].Chart.ID, OrderedChartIDs: []domain.ID{first.Items[0].Chart.ID},
	})
	if err != nil || len(trimmed.Items) != 1 {
		t.Fatalf("trimmed = %+v, err = %v", trimmed, err)
	}
	if _, err := store.UpdateLayout(context.Background(), testActor, ports.UpdateCanvasInput{SessionID: testSessionID, ExpectedRevision: updated.Revision, Layout: domain.CanvasFlex}); appCode(err) != domain.ErrorConflict {
		t.Fatalf("stale error = %v", err)
	}
	var queryCount int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM queries`).Scan(&queryCount); err != nil || queryCount != 1 {
		t.Fatalf("query count = %d, err = %v", queryCount, err)
	}
}

func TestStoreScopesRowsAndDeleteCascades(t *testing.T) {
	store, _ := openTestStore(t)
	if _, err := store.PublishQueryChart(context.Background(), testActor, publishInput(t, "publish-0005")); err != nil {
		t.Fatal(err)
	}
	other := testActor
	other.UserID = "user-b"
	projection, err := store.Get(context.Background(), other, testSessionID)
	if err != nil || projection.Revision != 0 || len(projection.Items) != 0 {
		t.Fatalf("other projection = %+v, err = %v", projection, err)
	}
	if err := store.Delete(context.Background(), testActor, testSessionID); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"canvases", "queries", "charts", "canvas_items"} {
		var count int
		if err := store.db.QueryRow(`SELECT COUNT(*) FROM ` + table).Scan(&count); err != nil || count != 0 {
			t.Fatalf("%s count = %d, err = %v", table, count, err)
		}
	}
}

func TestSchemaContainsNoAgentOrQueryResultTables(t *testing.T) {
	store, _ := openTestStore(t)
	rows, err := store.db.Query(`SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	tables := map[string]string{}
	for rows.Next() {
		var name, schema string
		if err := rows.Scan(&name, &schema); err != nil {
			t.Fatal(err)
		}
		tables[name] = schema
	}
	for _, forbidden := range []string{"sessions", "turns", "messages", "events", "samples", "series", "frames", "results"} {
		if _, exists := tables[forbidden]; exists {
			t.Fatalf("forbidden table %q exists", forbidden)
		}
	}
	for _, required := range []string{"schema_migrations", "canvases", "queries", "charts", "canvas_items"} {
		if tables[required] == "" {
			t.Fatalf("required table %q missing", required)
		}
	}
}

func TestOpenRejectsMigrationChecksumDrift(t *testing.T) {
	store, path := openTestStore(t)
	if _, err := store.db.Exec(`UPDATE schema_migrations SET checksum='changed' WHERE version=1`); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := Open(path); err == nil {
		t.Fatal("checksum drift accepted")
	}
}

func appCode(err error) domain.ErrorCode {
	var appErr *domain.AppError
	if errors.As(err, &appErr) {
		return appErr.Code
	}
	return ""
}
