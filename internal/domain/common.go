package domain

import (
	"errors"
	"regexp"
	"time"
)

type ID string

var businessIDPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{1,15}_[A-Za-z0-9_-]{8,64}$`)

func (id ID) Valid() bool { return businessIDPattern.MatchString(string(id)) }

type ActorContext struct {
	TenantID  string
	OrgID     string
	UserID    string
	FolderUID string
	Roles     []string
}

func (actor ActorContext) Validate() error {
	if actor.TenantID == "" || actor.OrgID == "" || actor.UserID == "" {
		return errors.New("actor tenant, organization and user are required")
	}
	return nil
}

type PageRequest struct {
	Cursor string
	Limit  int
}

type Page[T any] struct {
	Items      []T
	NextCursor string
	HasMore    bool
}

type Version int64

type AuditStamp struct {
	CreatedAt time.Time
	UpdatedAt time.Time
	Version   Version
}

type IdempotencyKey string

type ErrorCode string

const (
	ErrorInvalidArgument       ErrorCode = "invalid_argument"
	ErrorUnauthenticated       ErrorCode = "unauthenticated"
	ErrorForbidden             ErrorCode = "forbidden"
	ErrorNotFound              ErrorCode = "not_found"
	ErrorConflict              ErrorCode = "conflict"
	ErrorCapabilityUnavailable ErrorCode = "capability_unavailable"
	ErrorProviderTimeout       ErrorCode = "provider_timeout"
	ErrorProviderUnavailable   ErrorCode = "provider_unavailable"
	ErrorInternal              ErrorCode = "internal"
)

type AppError struct {
	Code      ErrorCode
	Message   string
	Retryable bool
	Cause     error
}

func (e *AppError) Error() string { return e.Message }
func (e *AppError) Unwrap() error { return e.Cause }
