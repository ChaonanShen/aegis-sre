package postgres

import (
	"bytes"
	"context"
	"errors"
	"fmt"

	"github.com/1024XEngineer/aegis-sre/internal/application"
	"github.com/1024XEngineer/aegis-sre/internal/domain"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type DBTX interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
	QueryRow(context.Context, string, ...any) pgx.Row
}

type Repository struct{ db DBTX }

func New(db DBTX) *Repository { return &Repository{db: db} }

func (repository *Repository) Create(ctx context.Context, actor domain.ActorContext, session domain.Session) error {
	_, err := repository.db.Exec(ctx, `
INSERT INTO agent_sessions (id, tenant_id, org_id, owner_user_id, folder_uid, title, status, version, created_at, updated_at)
VALUES ($1, $2, $3, $4, NULLIF($5, ''), $6, $7, $8, $9, $10)`,
		session.ID, actor.TenantID, actor.OrgID, actor.UserID, session.FolderUID, session.Title,
		session.Status, session.Version, session.CreatedAt, session.UpdatedAt)
	return mapError(err)
}

func (repository *Repository) Get(ctx context.Context, actor domain.ActorContext, id domain.ID) (domain.Session, error) {
	var session domain.Session
	err := repository.db.QueryRow(ctx, `
SELECT id, title, status, COALESCE(folder_uid, ''), version, created_at, updated_at
FROM agent_sessions
WHERE id = $1 AND tenant_id = $2 AND org_id = $3 AND owner_user_id = $4`,
		id, actor.TenantID, actor.OrgID, actor.UserID).Scan(
		&session.ID, &session.Title, &session.Status, &session.FolderUID, &session.Version,
		&session.CreatedAt, &session.UpdatedAt)
	return session, mapError(err)
}

func (repository *Repository) Update(ctx context.Context, actor domain.ActorContext, session domain.Session, expected domain.Version) error {
	result, err := repository.db.Exec(ctx, `
UPDATE agent_sessions
SET title = $1, status = $2, folder_uid = NULLIF($3, ''), version = version + 1, updated_at = $4
WHERE id = $5 AND tenant_id = $6 AND org_id = $7 AND owner_user_id = $8 AND version = $9`,
		session.Title, session.Status, session.FolderUID, session.UpdatedAt, session.ID,
		actor.TenantID, actor.OrgID, actor.UserID, expected)
	if err != nil {
		return mapError(err)
	}
	if result.RowsAffected() != 1 {
		return &domain.AppError{Code: domain.ErrorConflict, Message: "session version conflict"}
	}
	return nil
}

func (repository *Repository) Upsert(ctx context.Context, mapping application.ProviderMapping) error {
	table, ownerColumn, err := mappingTable(mapping.Kind)
	if err != nil {
		return err
	}
	query := fmt.Sprintf(`
INSERT INTO %s (%s, provider, provider_id, sync_version)
VALUES ($1, $2, $3, NULLIF($4, ''))
ON CONFLICT (%s) DO UPDATE
SET provider = EXCLUDED.provider, provider_id = EXCLUDED.provider_id,
    sync_version = EXCLUDED.sync_version, updated_at = now()`, table, ownerColumn, ownerColumn)
	_, err = repository.db.Exec(ctx, query, mapping.BusinessID, mapping.Provider, mapping.ProviderID, mapping.SyncVersion)
	return mapError(err)
}

func (repository *Repository) Find(ctx context.Context, kind application.ProviderMappingKind, id domain.ID) (application.ProviderMapping, error) {
	table, ownerColumn, err := mappingTable(kind)
	if err != nil {
		return application.ProviderMapping{}, err
	}
	query := fmt.Sprintf("SELECT provider, provider_id, COALESCE(sync_version, '') FROM %s WHERE %s = $1", table, ownerColumn)
	mapping := application.ProviderMapping{Kind: kind, BusinessID: id}
	err = repository.db.QueryRow(ctx, query, id).Scan(&mapping.Provider, &mapping.ProviderID, &mapping.SyncVersion)
	return mapping, mapError(err)
}

func (repository *Repository) Claim(ctx context.Context, claim application.IdempotencyClaim) (application.ClaimResult, error) {
	result, err := repository.db.Exec(ctx, `
INSERT INTO operation_idempotency
    (tenant_id, org_id, actor_user_id, operation, idempotency_key, request_hash, status, trace_id, expires_at)
VALUES ($1, $2, $3, $4, $5, $6, 'started', $7, $8)
ON CONFLICT DO NOTHING`,
		claim.Actor.TenantID, claim.Actor.OrgID, claim.Actor.UserID, claim.Operation, claim.Key,
		claim.RequestHash, claim.TraceID, claim.ExpiresAt)
	if err != nil {
		return application.ClaimResult{}, mapError(err)
	}
	if result.RowsAffected() == 1 {
		return application.ClaimResult{Acquired: true, Record: application.IdempotencyRecord{
			IdempotencyClaim: claim,
			Status:           "started",
		}}, nil
	}

	existing := application.IdempotencyRecord{IdempotencyClaim: claim}
	var existingHash []byte
	err = repository.db.QueryRow(ctx, `
SELECT request_hash, COALESCE(resource_id, ''), status, trace_id, expires_at
FROM operation_idempotency
WHERE tenant_id = $1 AND org_id = $2 AND actor_user_id = $3 AND operation = $4 AND idempotency_key = $5`,
		claim.Actor.TenantID, claim.Actor.OrgID, claim.Actor.UserID, claim.Operation, claim.Key).Scan(
		&existingHash, &existing.ResourceID, &existing.Status, &existing.TraceID, &existing.ExpiresAt)
	if err != nil {
		return application.ClaimResult{}, mapError(err)
	}
	if !bytes.Equal(existingHash, claim.RequestHash) {
		return application.ClaimResult{}, &domain.AppError{
			Code:    domain.ErrorConflict,
			Message: "idempotency key was already used with a different request",
		}
	}
	existing.RequestHash = existingHash
	return application.ClaimResult{Record: existing}, nil
}

func (repository *Repository) Complete(ctx context.Context, claim application.IdempotencyClaim, resourceID domain.ID) error {
	result, err := repository.db.Exec(ctx, `
UPDATE operation_idempotency
SET resource_id = $1, status = 'completed', updated_at = now()
WHERE tenant_id = $2 AND org_id = $3 AND actor_user_id = $4 AND operation = $5
  AND idempotency_key = $6 AND request_hash = $7 AND status = 'started'`,
		resourceID, claim.Actor.TenantID, claim.Actor.OrgID, claim.Actor.UserID,
		claim.Operation, claim.Key, claim.RequestHash)
	if err != nil {
		return mapError(err)
	}
	if result.RowsAffected() != 1 {
		return &domain.AppError{Code: domain.ErrorConflict, Message: "idempotent operation cannot be completed"}
	}
	return nil
}

func mappingTable(kind application.ProviderMappingKind) (string, string, error) {
	switch kind {
	case application.MappingKnowledgeCollection:
		return "provider_collections", "knowledge_base_id", nil
	case application.MappingKnowledgeDocument:
		return "provider_documents", "document_id", nil
	case application.MappingAgentSession:
		return "provider_agent_sessions", "session_id", nil
	case application.MappingPlaybook:
		return "provider_playbooks", "playbook_id", nil
	case application.MappingPlaybookRun:
		return "provider_playbook_runs", "run_id", nil
	default:
		return "", "", &domain.AppError{Code: domain.ErrorInvalidArgument, Message: "unknown provider mapping kind"}
	}
}

func mapError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return &domain.AppError{Code: domain.ErrorNotFound, Message: "resource not found", Cause: err}
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" {
		return &domain.AppError{Code: domain.ErrorConflict, Message: "resource already exists", Cause: err}
	}
	return &domain.AppError{Code: domain.ErrorInternal, Message: "persistence operation failed", Cause: err}
}

var (
	_ application.SessionRepository         = (*Repository)(nil)
	_ application.ProviderMappingRepository = (*Repository)(nil)
	_ application.IdempotencyRepository     = (*Repository)(nil)
)
