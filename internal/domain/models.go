package domain

import "time"

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
	CreatedAt time.Time
	UpdatedAt time.Time
}

type KnowledgeBase struct {
	ID        ID
	Name      string
	FolderUID string
	Enabled   bool
	CreatedAt time.Time
	UpdatedAt time.Time
}

type KnowledgeBaseStatus string

const (
	KnowledgeBaseActive   KnowledgeBaseStatus = "active"
	KnowledgeBaseDisabled KnowledgeBaseStatus = "disabled"
)

type DocumentStatus string

const (
	DocumentQueued DocumentStatus = "queued"
	// DocumentPending 只用于读取迁移前 Provider 数据，不得再用于新写入或公共响应。
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
	Service         string
	Tags            []string
	FailureReason   string
	Size            int64
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

type Playbook struct {
	ID        ID
	Name      string
	FolderUID string
	Enabled   bool
	CreatedAt time.Time
	UpdatedAt time.Time
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
	CreatedAt  time.Time
	UpdatedAt  time.Time
}
