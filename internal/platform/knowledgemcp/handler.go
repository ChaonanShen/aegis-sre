package knowledgemcp

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"unicode/utf8"

	"github.com/1024XEngineer/aegis-sre/internal/domain"
	"github.com/1024XEngineer/aegis-sre/internal/ports"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	maxSearchLimit         = 10
	maxSources             = 200
	maxDocumentChunks      = 20
	maxChunkBytes          = 4000
	maxStructuredTextBytes = 32 << 10
)

type Config struct {
	TokenFile  string
	TenantID   string
	OrgID      string
	UserID     string
	FolderUIDs []string
}

type service struct {
	provider ports.KnowledgeProvider
	config   Config
	folders  map[string]struct{}
}

func NewHandler(provider ports.KnowledgeProvider, config Config) (http.Handler, error) {
	if provider == nil || config.TokenFile == "" || config.TenantID == "" || config.OrgID == "" || config.UserID == "" || len(config.FolderUIDs) == 0 {
		return nil, errors.New("Knowledge MCP requires provider, token, actor and Folder allowlist")
	}
	folders := make(map[string]struct{}, len(config.FolderUIDs))
	for _, folder := range config.FolderUIDs {
		if strings.TrimSpace(folder) == "" {
			return nil, errors.New("Knowledge MCP Folder allowlist contains an empty value")
		}
		folders[folder] = struct{}{}
	}
	svc := &service{provider: provider, config: config, folders: folders}
	server := mcp.NewServer(&mcp.Implementation{Name: "aegis-knowledge", Version: "1.0.0"}, nil)
	mcp.AddTool(server, &mcp.Tool{Name: "knowledge.search", Description: "Search authorized operations knowledge and return bounded passages with stable citations."}, svc.search)
	mcp.AddTool(server, &mcp.Tool{Name: "knowledge.get_document", Description: "Read an authorized knowledge source and a bounded set of parsed chunks."}, svc.getDocument)
	mcp.AddTool(server, &mcp.Tool{Name: "knowledge.list_sources", Description: "List authorized knowledge bases and documents in one Folder."}, svc.listSources)
	streamable := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, nil)
	return bearerFile(config.TokenFile, streamable), nil
}

type searchInput struct {
	FolderUID        string   `json:"folder_uid" jsonschema:"required,authorized Grafana Folder UID"`
	Query            string   `json:"query" jsonschema:"required,search question or keywords"`
	KnowledgeBaseIDs []string `json:"knowledge_base_ids,omitempty" jsonschema:"optional Aegis Knowledge Base business IDs"`
	Service          string   `json:"service,omitempty" jsonschema:"optional service filter"`
	Limit            int      `json:"limit,omitempty" jsonschema:"maximum result count from 1 to 10"`
	Threshold        float64  `json:"threshold,omitempty" jsonschema:"minimum relevance score from 0 to 1"`
}

type citation struct {
	DocumentID string `json:"document_id"`
	SourceName string `json:"source_name"`
	Position   string `json:"position"`
	PageNumber int    `json:"page_number"`
}
type searchHit struct {
	Text     string   `json:"text"`
	Score    float64  `json:"score"`
	Citation citation `json:"citation"`
}
type searchOutput struct {
	Hits []searchHit `json:"hits"`
}

func (svc *service) search(ctx context.Context, _ *mcp.CallToolRequest, input searchInput) (*mcp.CallToolResult, searchOutput, error) {
	actor, err := svc.actor(input.FolderUID)
	if err != nil {
		return nil, searchOutput{}, err
	}
	query := strings.TrimSpace(input.Query)
	if query == "" || utf8.RuneCountInString(query) > 2000 {
		return nil, searchOutput{}, toolError("invalid_argument")
	}
	limit := input.Limit
	if limit == 0 {
		limit = 5
	}
	if limit < 1 || limit > maxSearchLimit || input.Threshold < 0 || input.Threshold > 1 {
		return nil, searchOutput{}, toolError("invalid_argument")
	}
	refs, err := svc.authorizedCollections(ctx, actor, input.KnowledgeBaseIDs)
	if err != nil {
		return nil, searchOutput{}, sanitize(err)
	}
	if len(refs) == 0 {
		return nil, searchOutput{Hits: []searchHit{}}, nil
	}
	hits, err := svc.provider.Retrieve(ctx, actor, ports.RetrievalInput{Query: query, Collections: refs, Service: strings.TrimSpace(input.Service), Limit: limit, Threshold: input.Threshold})
	if err != nil {
		return nil, searchOutput{}, sanitize(err)
	}
	result := make([]searchHit, 0, min(len(hits), limit))
	remaining := maxStructuredTextBytes
	for _, hit := range hits {
		if len(result) == limit || remaining <= 0 {
			break
		}
		text := boundedText(hit.Text, min(maxChunkBytes, remaining))
		remaining -= len(text)
		result = append(result, searchHit{Text: text, Score: hit.Score, Citation: citation{DocumentID: string(hit.Document.ID), SourceName: hit.SourceName, Position: hit.Position, PageNumber: hit.PageNumber}})
	}
	return nil, searchOutput{Hits: result}, nil
}

type documentInput struct {
	FolderUID       string `json:"folder_uid" jsonschema:"required,authorized Grafana Folder UID"`
	KnowledgeBaseID string `json:"knowledge_base_id" jsonschema:"required,Aegis Knowledge Base business ID"`
	DocumentID      string `json:"document_id" jsonschema:"required,Aegis Document business ID"`
}
type chunkOutput struct {
	Text       string `json:"text"`
	Position   string `json:"position"`
	PageNumber int    `json:"page_number"`
}
type documentOutput struct {
	ID        string        `json:"id"`
	Name      string        `json:"name"`
	MediaType string        `json:"media_type"`
	Service   string        `json:"service,omitempty"`
	Tags      []string      `json:"tags"`
	Status    string        `json:"status"`
	Chunks    []chunkOutput `json:"chunks"`
}

func (svc *service) getDocument(ctx context.Context, _ *mcp.CallToolRequest, input documentInput) (*mcp.CallToolResult, documentOutput, error) {
	actor, err := svc.actor(input.FolderUID)
	if err != nil {
		return nil, documentOutput{}, err
	}
	collectionID, documentID, err := validResourceIDs(input.KnowledgeBaseID, input.DocumentID)
	if err != nil {
		return nil, documentOutput{}, err
	}
	collection := ports.KnowledgeCollectionRef{ID: collectionID}
	if _, err := svc.provider.GetCollection(ctx, actor, collection); err != nil {
		return nil, documentOutput{}, sanitize(err)
	}
	ref := ports.KnowledgeDocumentRef{ID: documentID, CollectionID: collectionID}
	document, err := svc.provider.GetDocument(ctx, actor, ref)
	if err != nil {
		return nil, documentOutput{}, sanitize(err)
	}
	page, err := svc.provider.ListChunks(ctx, actor, ref, domain.PageRequest{Limit: maxDocumentChunks})
	if err != nil {
		return nil, documentOutput{}, sanitize(err)
	}
	chunks := make([]chunkOutput, 0, min(len(page.Items), maxDocumentChunks))
	remaining := maxStructuredTextBytes
	for _, chunk := range page.Items {
		if len(chunks) == maxDocumentChunks || remaining <= 0 {
			break
		}
		text := boundedText(chunk.Text, min(maxChunkBytes, remaining))
		remaining -= len(text)
		chunks = append(chunks, chunkOutput{Text: text, Position: chunk.Position, PageNumber: chunk.PageNumber})
	}
	return nil, documentOutput{ID: string(document.Ref.ID), Name: document.Name, MediaType: document.MediaType, Service: document.Service, Tags: append([]string(nil), document.Tags...), Status: string(document.Status), Chunks: chunks}, nil
}

type sourcesInput struct {
	FolderUID string `json:"folder_uid" jsonschema:"required,authorized Grafana Folder UID"`
	Service   string `json:"service,omitempty" jsonschema:"optional service filter"`
}
type sourceOutput struct {
	KnowledgeBaseID string   `json:"knowledge_base_id"`
	DocumentID      string   `json:"document_id"`
	Name            string   `json:"name"`
	MediaType       string   `json:"media_type"`
	Service         string   `json:"service,omitempty"`
	Tags            []string `json:"tags"`
	Status          string   `json:"status"`
}
type sourcesOutput struct {
	Sources []sourceOutput `json:"sources"`
}

func (svc *service) listSources(ctx context.Context, _ *mcp.CallToolRequest, input sourcesInput) (*mcp.CallToolResult, sourcesOutput, error) {
	actor, err := svc.actor(input.FolderUID)
	if err != nil {
		return nil, sourcesOutput{}, err
	}
	collections, err := svc.listCollections(ctx, actor)
	if err != nil {
		return nil, sourcesOutput{}, sanitize(err)
	}
	serviceFilter := strings.TrimSpace(input.Service)
	result := make([]sourceOutput, 0)
	for _, collection := range collections {
		cursor := ""
		for {
			page, err := svc.provider.ListDocuments(ctx, actor, collection.Ref, domain.PageRequest{Cursor: cursor, Limit: 100})
			if err != nil {
				return nil, sourcesOutput{}, sanitize(err)
			}
			for _, document := range page.Items {
				if serviceFilter != "" && document.Service != serviceFilter {
					continue
				}
				result = append(result, sourceOutput{KnowledgeBaseID: string(collection.Ref.ID), DocumentID: string(document.Ref.ID), Name: document.Name, MediaType: document.MediaType, Service: document.Service, Tags: append([]string(nil), document.Tags...), Status: string(document.Status)})
				if len(result) == maxSources {
					return nil, sourcesOutput{Sources: result}, nil
				}
			}
			if !page.HasMore {
				break
			}
			if page.NextCursor == "" || page.NextCursor == cursor {
				return nil, sourcesOutput{}, toolError("provider_unavailable")
			}
			cursor = page.NextCursor
		}
	}
	return nil, sourcesOutput{Sources: result}, nil
}

func (svc *service) authorizedCollections(ctx context.Context, actor domain.ActorContext, ids []string) ([]ports.KnowledgeCollectionRef, error) {
	if len(ids) == 0 {
		collections, err := svc.listCollections(ctx, actor)
		if err != nil {
			return nil, err
		}
		refs := make([]ports.KnowledgeCollectionRef, 0, len(collections))
		for _, collection := range collections {
			if collection.Status == domain.KnowledgeBaseActive {
				refs = append(refs, collection.Ref)
			}
		}
		return refs, nil
	}
	if len(ids) > 50 {
		return nil, toolError("invalid_argument")
	}
	refs := make([]ports.KnowledgeCollectionRef, 0, len(ids))
	for _, raw := range ids {
		id := domain.ID(raw)
		if !id.Valid() || !strings.HasPrefix(raw, "kbs_") {
			return nil, toolError("invalid_argument")
		}
		collection, err := svc.provider.GetCollection(ctx, actor, ports.KnowledgeCollectionRef{ID: id})
		if err != nil {
			return nil, err
		}
		if collection.Status != domain.KnowledgeBaseActive {
			return nil, toolError("forbidden")
		}
		refs = append(refs, collection.Ref)
	}
	return refs, nil
}

func (svc *service) listCollections(ctx context.Context, actor domain.ActorContext) ([]ports.KnowledgeCollection, error) {
	result := make([]ports.KnowledgeCollection, 0)
	cursor := ""
	for len(result) < maxSources {
		page, err := svc.provider.ListCollections(ctx, actor, actor.FolderUID, domain.PageRequest{Cursor: cursor, Limit: 100})
		if err != nil {
			return nil, err
		}
		result = append(result, page.Items...)
		if !page.HasMore {
			break
		}
		if page.NextCursor == "" || page.NextCursor == cursor {
			return nil, toolError("provider_unavailable")
		}
		cursor = page.NextCursor
	}
	if len(result) > maxSources {
		result = result[:maxSources]
	}
	return result, nil
}

func (svc *service) actor(folderUID string) (domain.ActorContext, error) {
	if _, ok := svc.folders[folderUID]; !ok {
		return domain.ActorContext{}, toolError("forbidden")
	}
	return domain.ActorContext{TenantID: svc.config.TenantID, OrgID: svc.config.OrgID, UserID: svc.config.UserID, FolderUID: folderUID, Roles: []string{"viewer"}}, nil
}

func validResourceIDs(collection, document string) (domain.ID, domain.ID, error) {
	collectionID, documentID := domain.ID(collection), domain.ID(document)
	if !collectionID.Valid() || !strings.HasPrefix(collection, "kbs_") || !documentID.Valid() || !strings.HasPrefix(document, "doc_") {
		return "", "", toolError("invalid_argument")
	}
	return collectionID, documentID, nil
}

func boundedText(value string, limit int) string {
	if limit <= 0 {
		return ""
	}
	if len(value) <= limit {
		return value
	}
	value = value[:limit]
	for !utf8.ValidString(value) {
		value = value[:len(value)-1]
	}
	return value
}

func sanitize(err error) error {
	var appErr *domain.AppError
	if errors.As(err, &appErr) {
		switch appErr.Code {
		case domain.ErrorInvalidArgument, domain.ErrorForbidden, domain.ErrorNotFound, domain.ErrorConflict, domain.ErrorProviderTimeout, domain.ErrorProviderUnavailable, domain.ErrorProviderResultUnknown:
			return toolError(string(appErr.Code))
		}
	}
	return toolError("provider_unavailable")
}

func toolError(code string) error { return fmt.Errorf("knowledge tool failed: %s", code) }

func bearerFile(path string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		content, err := os.ReadFile(path)
		expected := strings.TrimSpace(string(content))
		provided, ok := strings.CutPrefix(request.Header.Get("Authorization"), "Bearer ")
		if err != nil || expected == "" || !ok || len(provided) != len(expected) || subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) != 1 {
			w.Header().Set("WWW-Authenticate", "Bearer")
			http.Error(w, "unauthorized caller", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, request)
	})
}
