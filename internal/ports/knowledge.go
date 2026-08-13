package ports

import (
	"context"
	"io"

	"github.com/1024XEngineer/aegis-sre/internal/domain"
)

type KnowledgeCollectionRef struct{ OpaqueID string }
type KnowledgeDocumentRef struct{ OpaqueID string }

type DocumentFile struct {
	Name      string
	MediaType string
	Content   io.Reader
}
type RetrievalInput struct {
	Query       string
	Collections []KnowledgeCollectionRef
	Limit       int
}
type RetrievalHit struct {
	Document KnowledgeDocumentRef
	Text     string
	Score    float64
	Position string
}

type KnowledgeProvider interface {
	CreateCollection(context.Context, domain.ActorContext, string) (KnowledgeCollectionRef, error)
	DeleteCollection(context.Context, domain.ActorContext, KnowledgeCollectionRef) error
	UploadDocument(context.Context, domain.ActorContext, KnowledgeCollectionRef, DocumentFile) (KnowledgeDocumentRef, error)
	StartIndexing(context.Context, domain.ActorContext, KnowledgeDocumentRef) error
	StopIndexing(context.Context, domain.ActorContext, KnowledgeDocumentRef) error
	DeleteDocument(context.Context, domain.ActorContext, KnowledgeDocumentRef) error
	Retrieve(context.Context, domain.ActorContext, RetrievalInput) ([]RetrievalHit, error)
}
