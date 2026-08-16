package ports

import (
	"context"
	"io"
	"time"

	"github.com/1024XEngineer/aegis-sre/internal/domain"
)

type KnowledgeCollectionRef struct{ ID domain.ID }
type KnowledgeBaseRef = KnowledgeCollectionRef
type KnowledgeDocumentRef struct {
	ID           domain.ID
	CollectionID domain.ID
}

type KnowledgeCollection struct {
	Ref       KnowledgeCollectionRef
	Name      string
	FolderUID string
	Status    domain.KnowledgeBaseStatus
	CreatedAt time.Time
	UpdatedAt time.Time
	ReadOnly  bool
}

// KnowledgeBase is the public product model. Provider lifecycle flags are not exposed.
type KnowledgeBase struct {
	Ref       KnowledgeBaseRef
	Name      string
	FolderUID string
	CreatedAt time.Time
	UpdatedAt time.Time
}

type CreateKnowledgeCollectionInput struct {
	ID        domain.ID
	Name      string
	FolderUID string
}

type CreateKnowledgeBaseInput = CreateKnowledgeCollectionInput

type UpdateKnowledgeBaseInput struct{ Name string }

type UpdateKnowledgeCollectionInput struct {
	Name   string
	Status domain.KnowledgeBaseStatus
}

type KnowledgeDocument struct {
	Ref           KnowledgeDocumentRef
	Name          string
	MediaType     string
	Service       string
	Tags          []string
	Status        domain.DocumentStatus
	FailureReason string
	Size          int64
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

type DocumentFile struct {
	ID        domain.ID
	Name      string
	MediaType string
	Service   string
	Tags      []string
	Size      int64
	SHA256    string
	Content   io.Reader
}

type UpdateKnowledgeDocumentInput struct {
	Service string
	Tags    []string
}

type KnowledgeChunk struct {
	ID         string
	Document   KnowledgeDocumentRef
	Text       string
	Position   string
	PageNumber int
	CreatedAt  time.Time
}

type DocumentPassage struct {
	Ordinal  int
	Text     string
	Location string
}

type KnowledgeSearchInput struct {
	Query          string
	KnowledgeBases []KnowledgeBaseRef
	Service        string
	TagsAny        []string
	TagsAll        []string
	Limit          int
}

type KnowledgeCitation struct {
	Document   KnowledgeDocumentRef
	SourceName string
	Text       string
	Ordinal    int
	Location   string
}

type RetrievalInput struct {
	Query       string
	Collections []KnowledgeCollectionRef
	Service     string
	Limit       int
	Threshold   float64
}

type RetrievalHit struct {
	Document   KnowledgeDocumentRef
	SourceName string
	Text       string
	Score      float64
	Position   string
	PageNumber int
}

type KnowledgeDocumentDownload struct {
	Name      string
	MediaType string
	Size      int64
	Content   io.ReadCloser
}

type KnowledgeIDGenerator interface {
	CollectionID(domain.ActorContext, string) (domain.ID, error)
	DocumentID(domain.ID, string) (domain.ID, error)
}

type KnowledgeProvider interface {
	Check(context.Context) error
	ListKnowledgeBases(context.Context, domain.ActorContext, domain.PageRequest) (domain.Page[KnowledgeBase], error)
	GetKnowledgeBase(context.Context, domain.ActorContext, KnowledgeBaseRef) (KnowledgeBase, error)
	CreateKnowledgeBase(context.Context, domain.ActorContext, CreateKnowledgeBaseInput) (KnowledgeBase, error)
	UpdateKnowledgeBase(context.Context, domain.ActorContext, KnowledgeBaseRef, UpdateKnowledgeBaseInput) (KnowledgeBase, error)
	DeleteKnowledgeBase(context.Context, domain.ActorContext, KnowledgeBaseRef) error
	ListDocuments(context.Context, domain.ActorContext, KnowledgeBaseRef, domain.PageRequest) (domain.Page[KnowledgeDocument], error)
	GetDocument(context.Context, domain.ActorContext, KnowledgeDocumentRef) (KnowledgeDocument, error)
	UploadDocument(context.Context, domain.ActorContext, KnowledgeBaseRef, DocumentFile) (KnowledgeDocument, error)
	UpdateDocumentMetadata(context.Context, domain.ActorContext, KnowledgeDocumentRef, UpdateKnowledgeDocumentInput) (KnowledgeDocument, error)
	RetryDocumentIndex(context.Context, domain.ActorContext, KnowledgeDocumentRef) (KnowledgeDocument, error)
	DeleteDocument(context.Context, domain.ActorContext, KnowledgeDocumentRef) error
	DownloadDocument(context.Context, domain.ActorContext, KnowledgeDocumentRef) (KnowledgeDocumentDownload, error)
	ListDocumentPassages(context.Context, domain.ActorContext, KnowledgeDocumentRef, domain.PageRequest) (domain.Page[DocumentPassage], error)
	Search(context.Context, domain.ActorContext, KnowledgeSearchInput) ([]KnowledgeCitation, error)
}

// LegacyKnowledgeProvider exists only for the time-bounded RAGFlow rollback window.
// New product code must depend on KnowledgeProvider.
type LegacyKnowledgeProvider interface {
	Check(context.Context) error
	ListCollections(context.Context, domain.ActorContext, string, domain.PageRequest) (domain.Page[KnowledgeCollection], error)
	GetCollection(context.Context, domain.ActorContext, KnowledgeCollectionRef) (KnowledgeCollection, error)
	CreateCollection(context.Context, domain.ActorContext, CreateKnowledgeCollectionInput) (KnowledgeCollection, error)
	UpdateCollection(context.Context, domain.ActorContext, KnowledgeCollectionRef, UpdateKnowledgeCollectionInput) (KnowledgeCollection, error)
	MigrateCollectionScope(context.Context, domain.ActorContext, KnowledgeCollectionRef) (KnowledgeCollection, error)
	DeleteCollection(context.Context, domain.ActorContext, KnowledgeCollectionRef) error
	ListDocuments(context.Context, domain.ActorContext, KnowledgeCollectionRef, domain.PageRequest) (domain.Page[KnowledgeDocument], error)
	GetDocument(context.Context, domain.ActorContext, KnowledgeDocumentRef) (KnowledgeDocument, error)
	UploadDocument(context.Context, domain.ActorContext, KnowledgeCollectionRef, DocumentFile) (KnowledgeDocument, error)
	UpdateDocument(context.Context, domain.ActorContext, KnowledgeDocumentRef, UpdateKnowledgeDocumentInput) (KnowledgeDocument, error)
	StartIndexing(context.Context, domain.ActorContext, KnowledgeDocumentRef) error
	StopIndexing(context.Context, domain.ActorContext, KnowledgeDocumentRef) error
	DeleteDocument(context.Context, domain.ActorContext, KnowledgeDocumentRef) error
	ListChunks(context.Context, domain.ActorContext, KnowledgeDocumentRef, domain.PageRequest) (domain.Page[KnowledgeChunk], error)
	DownloadDocument(context.Context, domain.ActorContext, KnowledgeDocumentRef) (KnowledgeDocumentDownload, error)
	Retrieve(context.Context, domain.ActorContext, RetrievalInput) ([]RetrievalHit, error)
}
