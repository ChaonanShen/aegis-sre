// Package canvassqlite persists only Aegis-owned Canvas projections.
package canvassqlite

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"strings"
	"time"

	"github.com/1024XEngineer/aegis-sre/internal/domain"
	"github.com/1024XEngineer/aegis-sre/internal/ports"
	_ "modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrationFiles embed.FS

type Store struct {
	db  *sql.DB
	now func() time.Time
}

func Open(path string) (*Store, error) {
	if strings.TrimSpace(path) == "" {
		return nil, errors.New("Canvas database path is required")
	}
	separator := "?"
	if strings.Contains(path, "?") {
		separator = "&"
	}
	db, err := sql.Open("sqlite", path+separator+"_txlock=immediate")
	if err != nil {
		return nil, errors.New("open Canvas database")
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	store := &Store{db: db, now: func() time.Time { return time.Now().UTC() }}
	if err := store.initialize(context.Background()); err != nil {
		_ = db.Close()
		return nil, err
	}
	if path != ":memory:" && !strings.HasPrefix(path, "file::memory:") {
		_ = os.Chmod(path, 0o600)
	}
	return store, nil
}

func (store *Store) initialize(ctx context.Context) error {
	for _, statement := range []string{
		`PRAGMA foreign_keys = ON`,
		`PRAGMA busy_timeout = 5000`,
		`PRAGMA synchronous = FULL`,
	} {
		if _, err := store.db.ExecContext(ctx, statement); err != nil {
			return errors.New("configure Canvas database")
		}
	}
	var journal string
	if err := store.db.QueryRowContext(ctx, `PRAGMA journal_mode = WAL`).Scan(&journal); err != nil {
		return errors.New("configure Canvas journal")
	}
	if err := store.migrate(ctx); err != nil {
		return err
	}
	return store.Check(ctx)
}

func (store *Store) migrate(ctx context.Context) error {
	if _, err := store.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL
	)`); err != nil {
		return errors.New("initialize Canvas migrations")
	}
	entries, err := fs.ReadDir(migrationFiles, "migrations")
	if err != nil {
		return errors.New("read Canvas migrations")
	}
	for index, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		version := index + 1
		body, err := migrationFiles.ReadFile("migrations/" + entry.Name())
		if err != nil {
			return errors.New("read Canvas migration")
		}
		sum := sha256.Sum256(body)
		checksum := hex.EncodeToString(sum[:])
		var stored string
		err = store.db.QueryRowContext(ctx, `SELECT checksum FROM schema_migrations WHERE version=?`, version).Scan(&stored)
		if err == nil {
			if stored != checksum {
				return errors.New("Canvas migration checksum mismatch")
			}
			continue
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return errors.New("read Canvas migration state")
		}
		tx, err := store.db.BeginTx(ctx, nil)
		if err != nil {
			return errors.New("begin Canvas migration")
		}
		if _, err = tx.ExecContext(ctx, string(body)); err == nil {
			_, err = tx.ExecContext(ctx, `INSERT INTO schema_migrations(version,checksum,applied_at) VALUES(?,?,?)`, version, checksum, encodeTime(store.now()))
		}
		if err != nil {
			_ = tx.Rollback()
			return errors.New("apply Canvas migration")
		}
		if err := tx.Commit(); err != nil {
			return errors.New("commit Canvas migration")
		}
	}
	var newest int
	if err := store.db.QueryRowContext(ctx, `SELECT COALESCE(MAX(version),0) FROM schema_migrations`).Scan(&newest); err != nil || newest > len(entries) {
		return errors.New("Canvas database schema is newer than this binary")
	}
	return nil
}

func (store *Store) Check(ctx context.Context) error {
	var result int
	if err := store.db.QueryRowContext(ctx, `SELECT 1`).Scan(&result); err != nil || result != 1 {
		return errors.New("Canvas database is unavailable")
	}
	var integrity string
	if err := store.db.QueryRowContext(ctx, `PRAGMA quick_check`).Scan(&integrity); err != nil || integrity != "ok" {
		return errors.New("Canvas database integrity check failed")
	}
	return nil
}

func (store *Store) Close() error {
	if store == nil || store.db == nil {
		return nil
	}
	_, _ = store.db.Exec(`PRAGMA wal_checkpoint(PASSIVE)`)
	return store.db.Close()
}

func (store *Store) Get(ctx context.Context, actor domain.ActorContext, sessionID domain.ID) (domain.CanvasProjection, error) {
	if err := validateScope(actor, sessionID); err != nil {
		return domain.CanvasProjection{}, err
	}
	return readProjection(ctx, store.db, actor, sessionID)
}

func (store *Store) PublishQueryChart(ctx context.Context, actor domain.ActorContext, input ports.PublishQueryChartInput) (domain.CanvasProjection, error) {
	if err := validateScope(actor, input.SessionID); err != nil {
		return domain.CanvasProjection{}, err
	}
	if len(input.OperationID) < 8 || len(input.OperationID) > 128 || !validRequestHash(input.RequestHash) {
		return domain.CanvasProjection{}, invalid("invalid Canvas publish identity", nil)
	}
	spec, err := domain.NormalizeQueryChartSpec(input.Spec)
	if err != nil {
		return domain.CanvasProjection{}, invalid("invalid query-backed Chart", err)
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return domain.CanvasProjection{}, internal(err)
	}
	defer tx.Rollback()
	var existingHash string
	err = tx.QueryRowContext(ctx, `SELECT publish_request_hash FROM charts WHERE tenant_id=? AND org_id=? AND user_id=? AND session_id=? AND publish_operation_id=?`, scopeArgs(actor, input.SessionID, input.OperationID)...).Scan(&existingHash)
	if err == nil {
		if existingHash != input.RequestHash {
			return domain.CanvasProjection{}, conflict("Canvas publish key was reused with different content")
		}
		projection, readErr := readProjection(ctx, tx, actor, input.SessionID)
		if readErr != nil {
			return domain.CanvasProjection{}, readErr
		}
		return projection, tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return domain.CanvasProjection{}, internal(err)
	}
	now := store.now().UTC()
	if _, err := tx.ExecContext(ctx, `INSERT INTO canvases(tenant_id,org_id,user_id,session_id,layout,visible,revision,created_at,updated_at)
		VALUES(?,?,?,?,?,1,0,?,?) ON CONFLICT(tenant_id,org_id,user_id,session_id) DO NOTHING`, actor.TenantID, actor.OrgID, actor.UserID, input.SessionID, domain.CanvasGrid2x2, encodeTime(now), encodeTime(now)); err != nil {
		return domain.CanvasProjection{}, internal(err)
	}
	var count int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM canvas_items WHERE tenant_id=? AND org_id=? AND user_id=? AND session_id=?`, scopeArgs(actor, input.SessionID)...).Scan(&count); err != nil {
		return domain.CanvasProjection{}, internal(err)
	}
	if count >= domain.MaxCanvasCharts {
		return domain.CanvasProjection{}, conflict("Canvas chart limit reached")
	}
	queryID, err := newID("qry_")
	if err != nil {
		return domain.CanvasProjection{}, internal(err)
	}
	chartID, err := newID("cht_")
	if err != nil {
		return domain.CanvasProjection{}, internal(err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO queries(tenant_id,org_id,user_id,session_id,query_id,version,language,datasource_uid,expression,range_from,range_to,step_seconds,created_at)
		VALUES(?,?,?,?,?,1,'promql',?,?,?,?,?,?)`, actor.TenantID, actor.OrgID, actor.UserID, input.SessionID, queryID, spec.DatasourceUID, spec.Expression, encodeTime(spec.From), encodeTime(spec.To), spec.StepSeconds, encodeTime(now)); err != nil {
		return domain.CanvasProjection{}, internal(err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO charts(tenant_id,org_id,user_id,session_id,chart_id,revision,query_id,query_version,title,description,visualization,viz_config_json,publish_operation_id,publish_request_hash,created_at,updated_at)
		VALUES(?,?,?,?,?,1,?,1,?,?,?,?,?,?,?,?)`, actor.TenantID, actor.OrgID, actor.UserID, input.SessionID, chartID, queryID, spec.Title, spec.Description, spec.Visualization, string(spec.VizConfig), input.OperationID, input.RequestHash, encodeTime(now), encodeTime(now)); err != nil {
		return domain.CanvasProjection{}, internal(err)
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO canvas_items(tenant_id,org_id,user_id,session_id,chart_id,position) VALUES(?,?,?,?,?,?)`, actor.TenantID, actor.OrgID, actor.UserID, input.SessionID, chartID, count); err != nil {
		return domain.CanvasProjection{}, internal(err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE canvases SET visible=1,active_chart_id=?,revision=revision+1,updated_at=? WHERE tenant_id=? AND org_id=? AND user_id=? AND session_id=?`, chartID, encodeTime(now), actor.TenantID, actor.OrgID, actor.UserID, input.SessionID); err != nil {
		return domain.CanvasProjection{}, internal(err)
	}
	if err := tx.Commit(); err != nil {
		return domain.CanvasProjection{}, internal(err)
	}
	return store.Get(ctx, actor, input.SessionID)
}

func (store *Store) UpdateLayout(ctx context.Context, actor domain.ActorContext, input ports.UpdateCanvasInput) (domain.CanvasProjection, error) {
	if err := validateScope(actor, input.SessionID); err != nil {
		return domain.CanvasProjection{}, err
	}
	if input.ExpectedRevision < 0 || !input.Layout.Valid() || len(input.OrderedChartIDs) > domain.MaxCanvasCharts {
		return domain.CanvasProjection{}, invalid("invalid Canvas layout update", nil)
	}
	provided := make(map[domain.ID]struct{}, len(input.OrderedChartIDs))
	for _, id := range input.OrderedChartIDs {
		if !validPrefixedID(id, "cht_") {
			return domain.CanvasProjection{}, invalid("invalid Chart ID", nil)
		}
		if _, exists := provided[id]; exists {
			return domain.CanvasProjection{}, invalid("duplicate Chart ID", nil)
		}
		provided[id] = struct{}{}
	}
	if input.ActiveChartID != "" {
		if _, ok := provided[input.ActiveChartID]; !ok {
			return domain.CanvasProjection{}, invalid("active Chart is not a Canvas member", nil)
		}
	}
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return domain.CanvasProjection{}, internal(err)
	}
	defer tx.Rollback()
	current, err := readProjection(ctx, tx, actor, input.SessionID)
	if err != nil {
		return domain.CanvasProjection{}, err
	}
	if current.Revision != input.ExpectedRevision {
		return domain.CanvasProjection{}, conflict("Canvas revision is stale")
	}
	known := make(map[domain.ID]domain.ID, len(current.Items))
	for _, item := range current.Items {
		known[item.Chart.ID] = item.Query.ID
	}
	for id := range provided {
		if _, ok := known[id]; !ok {
			return domain.CanvasProjection{}, invalid("unknown Chart cannot be added to Canvas", nil)
		}
	}
	now := store.now().UTC()
	if current.Revision == 0 {
		if len(input.OrderedChartIDs) != 0 {
			return domain.CanvasProjection{}, invalid("unknown Chart cannot be added to empty Canvas", nil)
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO canvases(tenant_id,org_id,user_id,session_id,layout,visible,active_chart_id,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,NULL,1,?,?)`, actor.TenantID, actor.OrgID, actor.UserID, input.SessionID, input.Layout, boolInt(input.Visible), encodeTime(now), encodeTime(now))
		if err != nil {
			return domain.CanvasProjection{}, internal(err)
		}
	} else {
		for chartID, queryID := range known {
			if _, keep := provided[chartID]; keep {
				continue
			}
			if _, err := tx.ExecContext(ctx, `DELETE FROM canvas_items WHERE tenant_id=? AND org_id=? AND user_id=? AND session_id=? AND chart_id=?`, scopeArgs(actor, input.SessionID, chartID)...); err != nil {
				return domain.CanvasProjection{}, internal(err)
			}
			if _, err := tx.ExecContext(ctx, `DELETE FROM charts WHERE tenant_id=? AND org_id=? AND user_id=? AND session_id=? AND chart_id=?`, scopeArgs(actor, input.SessionID, chartID)...); err != nil {
				return domain.CanvasProjection{}, internal(err)
			}
			if _, err := tx.ExecContext(ctx, `DELETE FROM queries WHERE tenant_id=? AND org_id=? AND user_id=? AND session_id=? AND query_id=?`, scopeArgs(actor, input.SessionID, queryID)...); err != nil {
				return domain.CanvasProjection{}, internal(err)
			}
		}
		if _, err := tx.ExecContext(ctx, `UPDATE canvas_items SET position=position+1000 WHERE tenant_id=? AND org_id=? AND user_id=? AND session_id=?`, scopeArgs(actor, input.SessionID)...); err != nil {
			return domain.CanvasProjection{}, internal(err)
		}
		for position, chartID := range input.OrderedChartIDs {
			if _, err := tx.ExecContext(ctx, `UPDATE canvas_items SET position=? WHERE tenant_id=? AND org_id=? AND user_id=? AND session_id=? AND chart_id=?`, append([]any{position}, scopeArgs(actor, input.SessionID, chartID)...)...); err != nil {
				return domain.CanvasProjection{}, internal(err)
			}
		}
		if _, err := tx.ExecContext(ctx, `UPDATE canvases SET layout=?,visible=?,active_chart_id=?,revision=revision+1,updated_at=? WHERE tenant_id=? AND org_id=? AND user_id=? AND session_id=?`, input.Layout, boolInt(input.Visible), nullableID(input.ActiveChartID), encodeTime(now), actor.TenantID, actor.OrgID, actor.UserID, input.SessionID); err != nil {
			return domain.CanvasProjection{}, internal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		return domain.CanvasProjection{}, internal(err)
	}
	return store.Get(ctx, actor, input.SessionID)
}

func (store *Store) Delete(ctx context.Context, actor domain.ActorContext, sessionID domain.ID) error {
	if err := validateScope(actor, sessionID); err != nil {
		return err
	}
	_, err := store.db.ExecContext(ctx, `DELETE FROM canvases WHERE tenant_id=? AND org_id=? AND user_id=? AND session_id=?`, scopeArgs(actor, sessionID)...)
	if err != nil {
		return internal(err)
	}
	return nil
}

type queryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

func readProjection(ctx context.Context, db queryer, actor domain.ActorContext, sessionID domain.ID) (domain.CanvasProjection, error) {
	projection := domain.CanvasProjection{SessionID: sessionID, Layout: domain.CanvasGrid2x2, Items: []domain.CanvasItem{}}
	var visible int
	var active sql.NullString
	var createdRaw, updatedRaw string
	err := db.QueryRowContext(ctx, `SELECT layout,visible,active_chart_id,revision,created_at,updated_at FROM canvases WHERE tenant_id=? AND org_id=? AND user_id=? AND session_id=?`, scopeArgs(actor, sessionID)...).Scan(&projection.Layout, &visible, &active, &projection.Revision, &createdRaw, &updatedRaw)
	if errors.Is(err, sql.ErrNoRows) {
		return projection, nil
	}
	if err != nil {
		return domain.CanvasProjection{}, internal(err)
	}
	projection.Visible = visible == 1
	projection.ActiveChartID = domain.ID(active.String)
	projection.CreatedAt, err = decodeTime(createdRaw)
	if err != nil {
		return domain.CanvasProjection{}, internal(err)
	}
	projection.UpdatedAt, err = decodeTime(updatedRaw)
	if err != nil {
		return domain.CanvasProjection{}, internal(err)
	}
	rows, err := db.QueryContext(ctx, `SELECT i.position,c.chart_id,c.revision,c.title,c.description,c.visualization,c.viz_config_json,c.created_at,c.updated_at,q.query_id,q.version,q.datasource_uid,q.expression,q.range_from,q.range_to,q.step_seconds,q.created_at
		FROM canvas_items i JOIN charts c USING(tenant_id,org_id,user_id,session_id,chart_id)
		JOIN queries q ON q.tenant_id=c.tenant_id AND q.org_id=c.org_id AND q.user_id=c.user_id AND q.session_id=c.session_id AND q.query_id=c.query_id AND q.version=c.query_version
		WHERE i.tenant_id=? AND i.org_id=? AND i.user_id=? AND i.session_id=? ORDER BY i.position`, scopeArgs(actor, sessionID)...)
	if err != nil {
		return domain.CanvasProjection{}, internal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var item domain.CanvasItem
		var viz, chartCreated, chartUpdated, queryFrom, queryTo, queryCreated string
		if err := rows.Scan(&item.Position, &item.Chart.ID, &item.Chart.Revision, &item.Chart.Title, &item.Chart.Description, &item.Chart.Visualization, &viz, &chartCreated, &chartUpdated, &item.Query.ID, &item.Query.Version, &item.Query.DatasourceUID, &item.Query.Expression, &queryFrom, &queryTo, &item.Query.StepSeconds, &queryCreated); err != nil {
			return domain.CanvasProjection{}, internal(err)
		}
		item.Chart.QueryID, item.Chart.QueryVersion = item.Query.ID, item.Query.Version
		item.Chart.VizConfig = json.RawMessage(viz)
		for index, raw := range []string{chartCreated, chartUpdated, queryFrom, queryTo, queryCreated} {
			parsed, err := decodeTime(raw)
			if err != nil {
				return domain.CanvasProjection{}, internal(err)
			}
			switch index {
			case 0:
				item.Chart.CreatedAt = parsed
			case 1:
				item.Chart.UpdatedAt = parsed
			case 2:
				item.Query.From = parsed
			case 3:
				item.Query.To = parsed
			case 4:
				item.Query.CreatedAt = parsed
			}
		}
		projection.Items = append(projection.Items, item)
	}
	if err := rows.Err(); err != nil {
		return domain.CanvasProjection{}, internal(err)
	}
	return projection, nil
}

func validateScope(actor domain.ActorContext, sessionID domain.ID) error {
	if err := actor.Validate(); err != nil {
		return &domain.AppError{Code: domain.ErrorUnauthenticated, Message: "trusted actor context is required", Cause: err}
	}
	if !validPrefixedID(sessionID, "ses_") {
		return invalid("invalid Session ID", nil)
	}
	return nil
}

func validPrefixedID(id domain.ID, prefix string) bool {
	return id.Valid() && strings.HasPrefix(string(id), prefix)
}

func validRequestHash(value string) bool {
	if len(value) != sha256.Size*2 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

func newID(prefix string) (domain.ID, error) {
	var data [18]byte
	if _, err := rand.Read(data[:]); err != nil {
		return "", err
	}
	return domain.ID(prefix + base64.RawURLEncoding.EncodeToString(data[:])), nil
}

func scopeArgs(actor domain.ActorContext, sessionID domain.ID, extra ...any) []any {
	result := []any{actor.TenantID, actor.OrgID, actor.UserID, sessionID}
	return append(result, extra...)
}

func encodeTime(value time.Time) string { return value.UTC().Format(time.RFC3339Nano) }

func decodeTime(value string) (time.Time, error) { return time.Parse(time.RFC3339Nano, value) }

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}

func nullableID(id domain.ID) any {
	if id == "" {
		return nil
	}
	return id
}

func invalid(message string, cause error) error {
	return &domain.AppError{Code: domain.ErrorInvalidArgument, Message: message, Cause: cause}
}

func conflict(message string) error {
	return &domain.AppError{Code: domain.ErrorConflict, Message: message}
}

func internal(cause error) error {
	return &domain.AppError{Code: domain.ErrorInternal, Message: "Canvas storage operation failed", Retryable: true, Cause: cause}
}

// StableRequestHash returns the canonical hash used by HTTP and MCP callers.
func StableRequestHash(spec domain.QueryChartSpec) (string, error) {
	normalized, err := domain.NormalizeQueryChartSpec(spec)
	if err != nil {
		return "", err
	}
	value := struct {
		DatasourceUID string          `json:"datasource_uid"`
		Expression    string          `json:"expression"`
		From          string          `json:"from"`
		To            string          `json:"to"`
		StepSeconds   int64           `json:"step_seconds"`
		Title         string          `json:"title"`
		Description   string          `json:"description"`
		Visualization string          `json:"visualization"`
		VizConfig     json.RawMessage `json:"viz_config"`
	}{normalized.DatasourceUID, normalized.Expression, encodeTime(normalized.From), encodeTime(normalized.To), normalized.StepSeconds, normalized.Title, normalized.Description, normalized.Visualization, normalized.VizConfig}
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:]), nil
}

var _ ports.CanvasStore = (*Store)(nil)
