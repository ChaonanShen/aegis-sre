package postgres

import (
	"context"
	"errors"
	"regexp"
	"testing"
	"time"

	"github.com/1024XEngineer/aegis-sre/internal/application"
	"github.com/1024XEngineer/aegis-sre/internal/domain"
	"github.com/pashagolub/pgxmock/v4"
)

func TestClaimAcquiresNewIdempotencyKey(t *testing.T) {
	database, err := pgxmock.NewPool()
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	database.ExpectExec("INSERT INTO operation_idempotency").
		WithArgs(anyArgs(8)...).
		WillReturnResult(pgxmock.NewResult("INSERT", 1))

	result, err := New(database).Claim(context.Background(), testClaim())
	if err != nil {
		t.Fatalf("Claim() error = %v", err)
	}
	if !result.Acquired || result.Record.Status != "started" {
		t.Fatalf("unexpected result: %+v", result)
	}
	if err := database.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestClaimReplaysSameRequest(t *testing.T) {
	database, err := pgxmock.NewPool()
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	claim := testClaim()
	database.ExpectExec("INSERT INTO operation_idempotency").
		WithArgs(anyArgs(8)...).
		WillReturnResult(pgxmock.NewResult("INSERT", 0))
	database.ExpectQuery(regexp.QuoteMeta("SELECT request_hash, COALESCE(resource_id, ''), status, trace_id, expires_at")).
		WithArgs(anyArgs(5)...).
		WillReturnRows(pgxmock.NewRows([]string{"request_hash", "resource_id", "status", "trace_id", "expires_at"}).
			AddRow(claim.RequestHash, "ses_0123456789", "completed", claim.TraceID, claim.ExpiresAt))

	result, err := New(database).Claim(context.Background(), claim)
	if err != nil {
		t.Fatalf("Claim() error = %v", err)
	}
	if result.Acquired || result.Record.ResourceID != "ses_0123456789" || result.Record.Status != "completed" {
		t.Fatalf("unexpected replay: %+v", result)
	}
}

func TestClaimRejectsSameKeyWithDifferentRequest(t *testing.T) {
	database, err := pgxmock.NewPool()
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	claim := testClaim()
	database.ExpectExec("INSERT INTO operation_idempotency").
		WithArgs(anyArgs(8)...).
		WillReturnResult(pgxmock.NewResult("INSERT", 0))
	database.ExpectQuery("SELECT request_hash").
		WithArgs(anyArgs(5)...).
		WillReturnRows(
			pgxmock.NewRows([]string{"request_hash", "resource_id", "status", "trace_id", "expires_at"}).
				AddRow([]byte("different"), "", "started", claim.TraceID, claim.ExpiresAt))

	_, err = New(database).Claim(context.Background(), claim)
	var appErr *domain.AppError
	if !errors.As(err, &appErr) || appErr.Code != domain.ErrorConflict {
		t.Fatalf("Claim() error = %v, want conflict", err)
	}
}

func TestUpdateUsesOptimisticVersion(t *testing.T) {
	database, err := pgxmock.NewPool()
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	database.ExpectExec("UPDATE agent_sessions").
		WithArgs(anyArgs(9)...).
		WillReturnResult(pgxmock.NewResult("UPDATE", 0))
	err = New(database).Update(context.Background(), testClaim().Actor, domain.Session{ID: "ses_0123456789"}, 3)
	var appErr *domain.AppError
	if !errors.As(err, &appErr) || appErr.Code != domain.ErrorConflict {
		t.Fatalf("Update() error = %v, want conflict", err)
	}
}

func TestMappingKindUsesFixedTableAllowlist(t *testing.T) {
	_, _, err := mappingTable(application.ProviderMappingKind("provider_tables; DROP TABLE services"))
	var appErr *domain.AppError
	if !errors.As(err, &appErr) || appErr.Code != domain.ErrorInvalidArgument {
		t.Fatalf("mappingTable() error = %v", err)
	}
}

func testClaim() application.IdempotencyClaim {
	return application.IdempotencyClaim{
		Actor:       domain.ActorContext{TenantID: "tenant", OrgID: "org", UserID: "user"},
		Operation:   "session.create",
		Key:         "request-0001",
		RequestHash: []byte("hash"),
		TraceID:     "trace-1",
		ExpiresAt:   time.Now().Add(time.Hour),
	}
}

func anyArgs(count int) []any {
	values := make([]any, count)
	for index := range values {
		values[index] = pgxmock.AnyArg()
	}
	return values
}
