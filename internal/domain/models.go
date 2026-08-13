package domain

type SessionStatus string

const (
	SessionActive   SessionStatus = "active"
	SessionArchived SessionStatus = "archived"
	SessionBusy     SessionStatus = "busy"
)

type Session struct {
	ID        ID
	Title     string
	Status    SessionStatus
	FolderUID string
	AuditStamp
}

type KnowledgeBase struct {
	ID        ID
	Name      string
	FolderUID string
	Enabled   bool
	AuditStamp
}

type DocumentStatus string

const (
	DocumentPending  DocumentStatus = "pending"
	DocumentIndexing DocumentStatus = "indexing"
	DocumentReady    DocumentStatus = "ready"
	DocumentFailed   DocumentStatus = "failed"
	DocumentDisabled DocumentStatus = "disabled"
)

type Document struct {
	ID              ID
	KnowledgeBaseID ID
	Name            string
	MediaType       string
	Status          DocumentStatus
	AuditStamp
}

type Playbook struct {
	ID        ID
	Name      string
	FolderUID string
	Enabled   bool
	AuditStamp
}

type RunStatus string

const (
	RunQueued             RunStatus = "queued"
	RunRunning            RunStatus = "running"
	RunWaitingForInput    RunStatus = "waiting_for_input"
	RunWaitingForApproval RunStatus = "waiting_for_approval"
	RunSucceeded          RunStatus = "succeeded"
	RunFailed             RunStatus = "failed"
	RunCancelled          RunStatus = "cancelled"
)

type PlaybookRun struct {
	ID         ID
	PlaybookID ID
	Status     RunStatus
	Sequence   int64
	AuditStamp
}
