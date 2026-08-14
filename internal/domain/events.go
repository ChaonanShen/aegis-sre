package domain

import (
	"encoding/json"
	"time"
)

type EventType string

const (
	EventMessageDelta      EventType = "message.delta"
	EventToolStarted       EventType = "tool.started"
	EventToolCompleted     EventType = "tool.completed"
	EventApprovalRequested EventType = "approval.requested"
	EventApprovalResolved  EventType = "approval.resolved"
	EventArtifactCreated   EventType = "artifact.created"
	EventTurnStarted       EventType = "turn.started"
	EventTurnCompleted     EventType = "turn.completed"
	EventTurnFailed        EventType = "turn.failed"
	EventRunUpdated        EventType = "run.updated"
)

type Event struct {
	ID         ID
	Type       EventType
	SessionID  ID
	TurnID     ID
	RunID      ID
	Sequence   int64
	OccurredAt time.Time
	Payload    json.RawMessage
}
