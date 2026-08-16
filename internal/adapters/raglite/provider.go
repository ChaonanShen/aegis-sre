package raglite

import (
	"context"
	"errors"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/1024XEngineer/aegis-sre/internal/adapters/knowledgeid"
	"github.com/1024XEngineer/aegis-sre/internal/domain"
	"github.com/1024XEngineer/aegis-sre/internal/ports"
)

type ragliteClient interface {
	Check(context.Context) error
	ListCollections(context.Context, string, string) ([]Collection, error)
	InventoryCollections(context.Context, string) ([]Collection, error)
	GetCollection(context.Context, string, string) (Collection, error)
	CreateCollection(context.Context, string, Collection) (Collection, error)
	UpdateCollection(context.Context, string, string, string, string) (Collection, error)
	MigrateCollectionScope(context.Context, string, string, string) (Collection, error)
	DeleteCollection(context.Context, string, string) error
	ListDocuments(context.Context, string, string) ([]Document, error)
	GetDocument(context.Context, string, string) (Document, error)
	UploadDocument(context.Context, string, string, string, string, string, string, []string, io.Reader) (Document, error)
	UpdateDocument(context.Context, string, string, string, []string) (Document, error)
	DeleteDocument(context.Context, string, string) error
	StartIndexing(context.Context, string, string) (Job, error)
	StopIndexing(context.Context, string, string) error
	RetryIndexing(context.Context, string, string) (Document, error)
	ListChunks(context.Context, string, string) ([]Chunk, error)
	ListPassages(context.Context, string, string) ([]Passage, error)
	Search(context.Context, string, string, []string, string, int, float64) ([]SearchHit, error)
	SearchProduct(context.Context, string, string, []string, string, []string, []string, int) ([]SearchHit, error)
	DownloadDocument(context.Context, string, string) (*http.Response, error)
}

type Provider struct {
	client ragliteClient
	ids    *knowledgeid.Codec
}

func NewProvider(client ragliteClient, ids *knowledgeid.Codec) (*Provider, error) {
	if client == nil || ids == nil {
		return nil, errors.New("RAGLite client and knowledge ID codec are required")
	}
	return &Provider{client: client, ids: ids}, nil
}
func (p *Provider) Check(ctx context.Context) error { return mapProviderError(p.client.Check(ctx)) }

func (p *Provider) InventoryOwnership(ctx context.Context, base domain.ActorContext, folderUIDs []string) ([]ports.RootResourceOwnership, error) {
	known := make(map[string]string, len(folderUIDs))
	for _, folderUID := range folderUIDs {
		actor := base
		actor.FolderUID = folderUID
		scope, err := p.ids.ScopeFingerprint(actor)
		if err != nil {
			return nil, invalidArgument(err)
		}
		known[scope] = folderUID
	}
	items, err := p.client.InventoryCollections(ctx, "scp_inventory")
	if err != nil {
		return nil, mapProviderError(err)
	}
	output := make([]ports.RootResourceOwnership, 0, len(items))
	for _, item := range items {
		id := domain.ID(item.ID)
		entry := ports.RootResourceOwnership{Kind: "knowledge_base", ID: id, State: ports.OwnershipInvalid}
		if id.Valid() && strings.HasPrefix(item.ID, "kbs_") {
			if folderUID := known[item.Scope]; folderUID != "" && folderUID == item.FolderUID {
				entry.FolderUID, entry.State = folderUID, ports.OwnershipActive
			} else if containsFolder(folderUIDs, item.FolderUID) {
				entry.OwnerKey, entry.State = item.Scope, ports.OwnershipLegacy
			} else {
				entry.OwnerKey, entry.State = item.Scope, ports.OwnershipOrphan
			}
		}
		output = append(output, entry)
	}
	return output, nil
}

func containsFolder(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func (p *Provider) ListKnowledgeBases(ctx context.Context, actor domain.ActorContext, page domain.PageRequest) (domain.Page[ports.KnowledgeBase], error) {
	scope, err := p.scope(actor)
	if err != nil {
		return domain.Page[ports.KnowledgeBase]{}, err
	}
	items, err := p.client.ListCollections(ctx, scope, actor.FolderUID)
	if err != nil {
		return domain.Page[ports.KnowledgeBase]{}, mapProviderError(err)
	}
	mapped := make([]ports.KnowledgeBase, 0, len(items))
	for _, item := range items {
		collection, mapErr := mapCollection(item, scope, actor.FolderUID)
		if mapErr != nil {
			return domain.Page[ports.KnowledgeBase]{}, mapErr
		}
		mapped = append(mapped, productKnowledgeBase(collection))
	}
	return paginate(mapped, page)
}

func (p *Provider) GetKnowledgeBase(ctx context.Context, actor domain.ActorContext, ref ports.KnowledgeBaseRef) (ports.KnowledgeBase, error) {
	item, err := p.requireCollection(ctx, actor, ref)
	return productKnowledgeBase(item), err
}

func (p *Provider) CreateKnowledgeBase(ctx context.Context, actor domain.ActorContext, input ports.CreateKnowledgeBaseInput) (ports.KnowledgeBase, error) {
	item, err := p.CreateCollection(ctx, actor, input)
	return productKnowledgeBase(item), err
}

func (p *Provider) UpdateKnowledgeBase(ctx context.Context, actor domain.ActorContext, ref ports.KnowledgeBaseRef, input ports.UpdateKnowledgeBaseInput) (ports.KnowledgeBase, error) {
	item, err := p.UpdateCollection(ctx, actor, ref, ports.UpdateKnowledgeCollectionInput{Name: input.Name, Status: domain.KnowledgeBaseActive})
	return productKnowledgeBase(item), err
}

func (p *Provider) DeleteKnowledgeBase(ctx context.Context, actor domain.ActorContext, ref ports.KnowledgeBaseRef) error {
	return p.DeleteCollection(ctx, actor, ref)
}

func productKnowledgeBase(item ports.KnowledgeCollection) ports.KnowledgeBase {
	return ports.KnowledgeBase{Ref: item.Ref, Name: item.Name, FolderUID: item.FolderUID, CreatedAt: item.CreatedAt, UpdatedAt: item.UpdatedAt}
}

func (p *Provider) ListCollections(ctx context.Context, actor domain.ActorContext, folder string, page domain.PageRequest) (domain.Page[ports.KnowledgeCollection], error) {
	if err := requireFolder(actor, folder); err != nil {
		return domain.Page[ports.KnowledgeCollection]{}, err
	}
	scope, _ := p.ids.ScopeFingerprint(actor)
	items, err := p.client.ListCollections(ctx, scope, folder)
	if err != nil {
		return domain.Page[ports.KnowledgeCollection]{}, mapProviderError(err)
	}
	legacyScope, _ := p.ids.LegacyScopeFingerprint(actor)
	legacyItems, err := p.client.ListCollections(ctx, legacyScope, folder)
	if err != nil {
		return domain.Page[ports.KnowledgeCollection]{}, mapProviderError(err)
	}
	mapped := make([]ports.KnowledgeCollection, 0, len(items)+len(legacyItems))
	seen := make(map[domain.ID]struct{}, len(items)+len(legacyItems))
	for _, item := range items {
		value, mapErr := mapCollection(item, scope, actor.FolderUID)
		if mapErr != nil {
			return domain.Page[ports.KnowledgeCollection]{}, mapErr
		}
		seen[value.Ref.ID] = struct{}{}
		mapped = append(mapped, value)
	}
	for _, item := range legacyItems {
		value, mapErr := mapCollection(item, legacyScope, actor.FolderUID)
		if mapErr != nil {
			return domain.Page[ports.KnowledgeCollection]{}, mapErr
		}
		if _, exists := seen[value.Ref.ID]; exists {
			return domain.Page[ports.KnowledgeCollection]{}, resultUnknown(errors.New("duplicate collection across current and legacy scopes"))
		}
		value.ReadOnly = true
		mapped = append(mapped, value)
	}
	return paginate(mapped, page)
}
func (p *Provider) GetCollection(ctx context.Context, actor domain.ActorContext, ref ports.KnowledgeCollectionRef) (ports.KnowledgeCollection, error) {
	collection, scope, err := p.readableCollection(ctx, actor, ref)
	legacyScope, _ := p.ids.LegacyScopeFingerprint(actor)
	collection.ReadOnly = err == nil && scope == legacyScope
	return collection, err
}
func (p *Provider) CreateCollection(ctx context.Context, actor domain.ActorContext, input ports.CreateKnowledgeCollectionInput) (ports.KnowledgeCollection, error) {
	if err := requireFolder(actor, input.FolderUID); err != nil {
		return ports.KnowledgeCollection{}, err
	}
	if !input.ID.Valid() || !strings.HasPrefix(string(input.ID), "kbs_") || strings.TrimSpace(input.Name) == "" {
		return ports.KnowledgeCollection{}, invalidArgument(errors.New("valid knowledge base ID and name are required"))
	}
	scope, _ := p.ids.ScopeFingerprint(actor)
	item, err := p.client.CreateCollection(ctx, scope, Collection{ID: string(input.ID), Name: input.Name, FolderUID: input.FolderUID})
	if err != nil {
		return ports.KnowledgeCollection{}, mapProviderError(err)
	}
	return mapCollection(item, scope, actor.FolderUID)
}
func (p *Provider) UpdateCollection(ctx context.Context, actor domain.ActorContext, ref ports.KnowledgeCollectionRef, input ports.UpdateKnowledgeCollectionInput) (ports.KnowledgeCollection, error) {
	scope, err := p.scope(actor)
	if err != nil {
		return ports.KnowledgeCollection{}, err
	}
	if _, err := p.requireCollection(ctx, actor, ref); err != nil {
		return ports.KnowledgeCollection{}, err
	}
	item, err := p.client.UpdateCollection(ctx, scope, string(ref.ID), input.Name, string(input.Status))
	if err != nil {
		return ports.KnowledgeCollection{}, mapProviderError(err)
	}
	return mapCollection(item, scope, actor.FolderUID)
}

func (p *Provider) MigrateCollectionScope(ctx context.Context, actor domain.ActorContext, ref ports.KnowledgeCollectionRef) (ports.KnowledgeCollection, error) {
	collection, sourceScope, err := p.readableCollection(ctx, actor, ref)
	if err != nil {
		return ports.KnowledgeCollection{}, err
	}
	legacyScope, _ := p.ids.LegacyScopeFingerprint(actor)
	if sourceScope != legacyScope {
		// Provider 迁移已完成但响应丢失时，重试返回当前资源，保持操作幂等。
		return collection, nil
	}
	targetScope, _ := p.ids.ScopeFingerprint(actor)
	item, err := p.client.MigrateCollectionScope(ctx, sourceScope, string(ref.ID), targetScope)
	if err != nil {
		return ports.KnowledgeCollection{}, mapProviderError(err)
	}
	migrated, err := mapCollection(item, targetScope, actor.FolderUID)
	if err != nil {
		return ports.KnowledgeCollection{}, err
	}
	migrated.Name = collection.Name
	return migrated, nil
}
func (p *Provider) DeleteCollection(ctx context.Context, actor domain.ActorContext, ref ports.KnowledgeCollectionRef) error {
	scope, err := p.scope(actor)
	if err != nil {
		return err
	}
	if _, err := p.requireCollection(ctx, actor, ref); err != nil {
		return err
	}
	return mapProviderError(p.client.DeleteCollection(ctx, scope, string(ref.ID)))
}
func (p *Provider) ListDocuments(ctx context.Context, actor domain.ActorContext, ref ports.KnowledgeCollectionRef, page domain.PageRequest) (domain.Page[ports.KnowledgeDocument], error) {
	if _, err := p.scope(actor); err != nil {
		return domain.Page[ports.KnowledgeDocument]{}, err
	}
	_, scope, err := p.readableCollection(ctx, actor, ref)
	if err != nil {
		return domain.Page[ports.KnowledgeDocument]{}, err
	}
	items, err := p.client.ListDocuments(ctx, scope, string(ref.ID))
	if err != nil {
		return domain.Page[ports.KnowledgeDocument]{}, mapProviderError(err)
	}
	mapped := make([]ports.KnowledgeDocument, 0, len(items))
	for _, item := range items {
		value, mapErr := mapDocument(item, ref.ID)
		if mapErr != nil {
			return domain.Page[ports.KnowledgeDocument]{}, mapErr
		}
		mapped = append(mapped, value)
	}
	return paginate(mapped, page)
}
func (p *Provider) GetDocument(ctx context.Context, actor domain.ActorContext, ref ports.KnowledgeDocumentRef) (ports.KnowledgeDocument, error) {
	if _, err := p.scope(actor); err != nil {
		return ports.KnowledgeDocument{}, err
	}
	_, scope, err := p.readableCollection(ctx, actor, ports.KnowledgeCollectionRef{ID: ref.CollectionID})
	if err != nil {
		return ports.KnowledgeDocument{}, err
	}
	item, err := p.client.GetDocument(ctx, scope, string(ref.ID))
	if err != nil {
		return ports.KnowledgeDocument{}, mapProviderError(err)
	}
	return mapDocument(item, ref.CollectionID)
}
func (p *Provider) UploadDocument(ctx context.Context, actor domain.ActorContext, collection ports.KnowledgeCollectionRef, file ports.DocumentFile) (ports.KnowledgeDocument, error) {
	scope, err := p.scope(actor)
	if err != nil {
		return ports.KnowledgeDocument{}, err
	}
	if _, err := p.requireCollection(ctx, actor, collection); err != nil {
		return ports.KnowledgeDocument{}, err
	}
	if !file.ID.Valid() || file.Content == nil || file.SHA256 == "" {
		return ports.KnowledgeDocument{}, invalidArgument(errors.New("valid document file is required"))
	}
	item, err := p.client.UploadDocument(ctx, scope, string(collection.ID), string(file.ID), file.Name, file.MediaType, file.Service, file.Tags, file.Content)
	if err != nil {
		return ports.KnowledgeDocument{}, mapProviderError(err)
	}
	if item.SHA256 != file.SHA256 || item.Size != file.Size {
		return ports.KnowledgeDocument{}, resultUnknown(errors.New("uploaded document digest does not match"))
	}
	return mapDocument(item, collection.ID)
}
func (p *Provider) UpdateDocument(ctx context.Context, actor domain.ActorContext, ref ports.KnowledgeDocumentRef, input ports.UpdateKnowledgeDocumentInput) (ports.KnowledgeDocument, error) {
	scope, err := p.scope(actor)
	if err != nil {
		return ports.KnowledgeDocument{}, err
	}
	if _, err := p.requireCollection(ctx, actor, ports.KnowledgeCollectionRef{ID: ref.CollectionID}); err != nil {
		return ports.KnowledgeDocument{}, err
	}
	item, err := p.client.UpdateDocument(ctx, scope, string(ref.ID), input.Service, input.Tags)
	if err != nil {
		return ports.KnowledgeDocument{}, mapProviderError(err)
	}
	return mapDocument(item, ref.CollectionID)
}
func (p *Provider) UpdateDocumentMetadata(ctx context.Context, actor domain.ActorContext, ref ports.KnowledgeDocumentRef, input ports.UpdateKnowledgeDocumentInput) (ports.KnowledgeDocument, error) {
	return p.UpdateDocument(ctx, actor, ref, input)
}

func (p *Provider) RetryDocumentIndex(ctx context.Context, actor domain.ActorContext, ref ports.KnowledgeDocumentRef) (ports.KnowledgeDocument, error) {
	scope, err := p.scope(actor)
	if err != nil {
		return ports.KnowledgeDocument{}, err
	}
	if _, err := p.requireCollection(ctx, actor, ports.KnowledgeBaseRef{ID: ref.CollectionID}); err != nil {
		return ports.KnowledgeDocument{}, err
	}
	item, err := p.client.RetryIndexing(ctx, scope, string(ref.ID))
	if err != nil {
		return ports.KnowledgeDocument{}, mapProviderError(err)
	}
	return mapDocument(item, ref.CollectionID)
}
func (p *Provider) StartIndexing(ctx context.Context, actor domain.ActorContext, ref ports.KnowledgeDocumentRef) error {
	scope, err := p.scope(actor)
	if err != nil {
		return err
	}
	if _, err := p.requireCollection(ctx, actor, ports.KnowledgeCollectionRef{ID: ref.CollectionID}); err != nil {
		return err
	}
	_, err = p.client.StartIndexing(ctx, scope, string(ref.ID))
	return mapProviderError(err)
}
func (p *Provider) StopIndexing(ctx context.Context, actor domain.ActorContext, ref ports.KnowledgeDocumentRef) error {
	scope, err := p.scope(actor)
	if err != nil {
		return err
	}
	if _, err := p.requireCollection(ctx, actor, ports.KnowledgeCollectionRef{ID: ref.CollectionID}); err != nil {
		return err
	}
	return mapProviderError(p.client.StopIndexing(ctx, scope, string(ref.ID)))
}
func (p *Provider) DeleteDocument(ctx context.Context, actor domain.ActorContext, ref ports.KnowledgeDocumentRef) error {
	scope, err := p.scope(actor)
	if err != nil {
		return err
	}
	if _, err := p.requireCollection(ctx, actor, ports.KnowledgeCollectionRef{ID: ref.CollectionID}); err != nil {
		return err
	}
	return mapProviderError(p.client.DeleteDocument(ctx, scope, string(ref.ID)))
}
func (p *Provider) ListChunks(ctx context.Context, actor domain.ActorContext, ref ports.KnowledgeDocumentRef, page domain.PageRequest) (domain.Page[ports.KnowledgeChunk], error) {
	if _, err := p.scope(actor); err != nil {
		return domain.Page[ports.KnowledgeChunk]{}, err
	}
	_, scope, err := p.readableCollection(ctx, actor, ports.KnowledgeCollectionRef{ID: ref.CollectionID})
	if err != nil {
		return domain.Page[ports.KnowledgeChunk]{}, err
	}
	items, err := p.client.ListChunks(ctx, scope, string(ref.ID))
	if err != nil {
		return domain.Page[ports.KnowledgeChunk]{}, mapProviderError(err)
	}
	mapped := make([]ports.KnowledgeChunk, 0, len(items))
	for _, item := range items {
		if item.DocumentID != string(ref.ID) {
			return domain.Page[ports.KnowledgeChunk]{}, resultUnknown(errors.New("chunk document does not match"))
		}
		id, idErr := p.ids.ChunkID(ref.ID, item.ID)
		if idErr != nil {
			return domain.Page[ports.KnowledgeChunk]{}, resultUnknown(idErr)
		}
		mapped = append(mapped, ports.KnowledgeChunk{ID: id, Document: ref, Text: item.Text, Position: item.Position, PageNumber: item.PageNumber})
	}
	return paginate(mapped, page)
}
func (p *Provider) ListDocumentPassages(ctx context.Context, actor domain.ActorContext, ref ports.KnowledgeDocumentRef, page domain.PageRequest) (domain.Page[ports.DocumentPassage], error) {
	if _, err := p.scope(actor); err != nil {
		return domain.Page[ports.DocumentPassage]{}, err
	}
	_, scope, err := p.readableCollection(ctx, actor, ports.KnowledgeBaseRef{ID: ref.CollectionID})
	if err != nil {
		return domain.Page[ports.DocumentPassage]{}, err
	}
	items, err := p.client.ListPassages(ctx, scope, string(ref.ID))
	if err != nil {
		return domain.Page[ports.DocumentPassage]{}, mapProviderError(err)
	}
	mapped := make([]ports.DocumentPassage, 0, len(items))
	for _, item := range items {
		if item.Ordinal < 1 || strings.TrimSpace(item.Text) == "" {
			return domain.Page[ports.DocumentPassage]{}, resultUnknown(errors.New("passage is invalid"))
		}
		mapped = append(mapped, ports.DocumentPassage{Ordinal: item.Ordinal, Text: item.Text, Location: item.Location})
	}
	return paginate(mapped, page)
}
func (p *Provider) DownloadDocument(ctx context.Context, actor domain.ActorContext, ref ports.KnowledgeDocumentRef) (ports.KnowledgeDocumentDownload, error) {
	if _, err := p.scope(actor); err != nil {
		return ports.KnowledgeDocumentDownload{}, err
	}
	_, scope, err := p.readableCollection(ctx, actor, ports.KnowledgeCollectionRef{ID: ref.CollectionID})
	if err != nil {
		return ports.KnowledgeDocumentDownload{}, err
	}
	item, err := p.client.GetDocument(ctx, scope, string(ref.ID))
	if err != nil {
		return ports.KnowledgeDocumentDownload{}, mapProviderError(err)
	}
	document, err := mapDocument(item, ref.CollectionID)
	if err != nil {
		return ports.KnowledgeDocumentDownload{}, err
	}
	response, err := p.client.DownloadDocument(ctx, scope, string(ref.ID))
	if err != nil {
		return ports.KnowledgeDocumentDownload{}, mapProviderError(err)
	}
	return ports.KnowledgeDocumentDownload{Name: document.Name, MediaType: document.MediaType, Size: document.Size, Content: response.Body}, nil
}
func (p *Provider) Retrieve(ctx context.Context, actor domain.ActorContext, input ports.RetrievalInput) ([]ports.RetrievalHit, error) {
	if _, err := p.scope(actor); err != nil {
		return nil, err
	}
	if strings.TrimSpace(input.Query) == "" || len(input.Collections) == 0 || input.Limit < 1 || input.Limit > 100 {
		return nil, invalidArgument(errors.New("invalid knowledge retrieval input"))
	}
	collectionsByScope := make(map[string][]string)
	allowedCollections := make(map[string]domain.ID, len(input.Collections))
	for _, ref := range input.Collections {
		_, scope, err := p.readableCollection(ctx, actor, ref)
		if err != nil {
			return nil, err
		}
		collectionsByScope[scope] = append(collectionsByScope[scope], string(ref.ID))
		allowedCollections[string(ref.ID)] = ref.ID
	}
	hits := make([]SearchHit, 0)
	for scope, collections := range collectionsByScope {
		result, err := p.client.Search(ctx, scope, input.Query, collections, input.Service, input.Limit, input.Threshold)
		if err != nil {
			return nil, mapProviderError(err)
		}
		hits = append(hits, result...)
	}
	sort.SliceStable(hits, func(i, j int) bool { return hits[i].Score > hits[j].Score })
	if len(hits) > input.Limit {
		hits = hits[:input.Limit]
	}
	mapped := make([]ports.RetrievalHit, 0, len(hits))
	for _, hit := range hits {
		documentID := domain.ID(hit.Chunk.DocumentID)
		if !documentID.Valid() || !strings.HasPrefix(string(documentID), "doc_") {
			return nil, resultUnknown(errors.New("retrieval document ID is invalid"))
		}
		collectionID, allowed := allowedCollections[hit.Chunk.CollectionID]
		if !allowed {
			return nil, resultUnknown(errors.New("retrieval collection is outside the request"))
		}
		mapped = append(mapped, ports.RetrievalHit{
			Document: ports.KnowledgeDocumentRef{ID: documentID, CollectionID: collectionID}, SourceName: hit.Chunk.SourceName,
			Text: hit.Chunk.Text, Score: hit.Score, Position: hit.Chunk.Position, PageNumber: hit.Chunk.PageNumber,
		})
	}
	return mapped, nil
}

func (p *Provider) Search(ctx context.Context, actor domain.ActorContext, input ports.KnowledgeSearchInput) ([]ports.KnowledgeCitation, error) {
	scope, err := p.scope(actor)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(input.Query) == "" || len(input.KnowledgeBases) == 0 || input.Limit < 1 || input.Limit > 100 {
		return nil, invalidArgument(errors.New("invalid knowledge search input"))
	}
	ids := make([]string, 0, len(input.KnowledgeBases))
	allowed := make(map[string]domain.ID, len(input.KnowledgeBases))
	for _, ref := range input.KnowledgeBases {
		if _, err := p.requireCollection(ctx, actor, ref); err != nil {
			return nil, err
		}
		ids = append(ids, string(ref.ID))
		allowed[string(ref.ID)] = ref.ID
	}
	hits, err := p.client.SearchProduct(ctx, scope, strings.TrimSpace(input.Query), ids, strings.TrimSpace(input.Service), input.TagsAny, input.TagsAll, input.Limit)
	if err != nil {
		return nil, mapProviderError(err)
	}
	result := make([]ports.KnowledgeCitation, 0, len(hits))
	for _, hit := range hits {
		collectionID, ok := allowed[hit.Chunk.CollectionID]
		documentID := domain.ID(hit.Chunk.DocumentID)
		if !ok || !documentID.Valid() || !strings.HasPrefix(string(documentID), "doc_") {
			return nil, resultUnknown(errors.New("search citation identity is invalid"))
		}
		ordinal := 1
		if index, parseErr := strconv.Atoi(hit.Chunk.Position); parseErr == nil && index >= 0 {
			ordinal = index + 1
		}
		result = append(result, ports.KnowledgeCitation{
			Document:   ports.KnowledgeDocumentRef{ID: documentID, CollectionID: collectionID},
			SourceName: hit.Chunk.SourceName, Text: hit.Chunk.Text, Ordinal: ordinal, Location: hit.Chunk.Position,
		})
	}
	return result, nil
}

func (p *Provider) scope(actor domain.ActorContext) (string, error) {
	if err := actor.Validate(); err != nil || actor.FolderUID == "" {
		return "", &domain.AppError{Code: domain.ErrorUnauthenticated, Message: "trusted actor context is required", Cause: err}
	}
	scope, err := p.ids.ScopeFingerprint(actor)
	if err != nil {
		return "", invalidArgument(err)
	}
	return scope, nil
}
func requireFolder(actor domain.ActorContext, folder string) error {
	if err := actor.Validate(); err != nil {
		return &domain.AppError{Code: domain.ErrorUnauthenticated, Message: "trusted actor context is required", Cause: err}
	}
	if actor.FolderUID == "" || folder == "" || actor.FolderUID != folder {
		return &domain.AppError{Code: domain.ErrorForbidden, Message: "folder context does not match"}
	}
	return nil
}
func (p *Provider) requireCollection(ctx context.Context, actor domain.ActorContext, ref ports.KnowledgeCollectionRef) (ports.KnowledgeCollection, error) {
	scope, err := p.scope(actor)
	if err != nil {
		return ports.KnowledgeCollection{}, err
	}
	item, err := p.client.GetCollection(ctx, scope, string(ref.ID))
	if err != nil {
		return ports.KnowledgeCollection{}, mapProviderError(err)
	}
	return mapCollection(item, scope, actor.FolderUID)
}

func (p *Provider) readableCollection(ctx context.Context, actor domain.ActorContext, ref ports.KnowledgeCollectionRef) (ports.KnowledgeCollection, string, error) {
	scope, err := p.scope(actor)
	if err != nil {
		return ports.KnowledgeCollection{}, "", err
	}
	item, err := p.client.GetCollection(ctx, scope, string(ref.ID))
	if err == nil {
		collection, mapErr := mapCollection(item, scope, actor.FolderUID)
		return collection, scope, mapErr
	}
	if !isProviderNotFound(err) {
		return ports.KnowledgeCollection{}, "", mapProviderError(err)
	}
	legacyScope, _ := p.ids.LegacyScopeFingerprint(actor)
	item, err = p.client.GetCollection(ctx, legacyScope, string(ref.ID))
	if err != nil {
		return ports.KnowledgeCollection{}, "", mapProviderError(err)
	}
	collection, mapErr := mapCollection(item, legacyScope, actor.FolderUID)
	return collection, legacyScope, mapErr
}

func isProviderNotFound(err error) bool {
	var providerErr *ProviderError
	return errors.As(err, &providerErr) && providerErr.Code == "not_found"
}

func mapCollection(item Collection, expectedScope, expectedFolder string) (ports.KnowledgeCollection, error) {
	id := domain.ID(item.ID)
	if !id.Valid() || !strings.HasPrefix(item.ID, "kbs_") || item.Scope != expectedScope || item.FolderUID != expectedFolder {
		return ports.KnowledgeCollection{}, resultUnknown(errors.New("collection identity or scope is invalid"))
	}
	created, err := time.Parse(time.RFC3339Nano, item.CreatedAt)
	if err != nil {
		return ports.KnowledgeCollection{}, resultUnknown(err)
	}
	updated, err := time.Parse(time.RFC3339Nano, item.UpdatedAt)
	if err != nil {
		return ports.KnowledgeCollection{}, resultUnknown(err)
	}
	status := domain.KnowledgeBaseStatus(item.Status)
	if status != domain.KnowledgeBaseActive && status != domain.KnowledgeBaseDisabled {
		return ports.KnowledgeCollection{}, resultUnknown(errors.New("collection status is invalid"))
	}
	return ports.KnowledgeCollection{Ref: ports.KnowledgeCollectionRef{ID: id}, Name: item.Name, FolderUID: item.FolderUID, Status: status, CreatedAt: created, UpdatedAt: updated}, nil
}
func mapDocument(item Document, collectionID domain.ID) (ports.KnowledgeDocument, error) {
	id := domain.ID(item.ID)
	if !id.Valid() || !strings.HasPrefix(item.ID, "doc_") || item.CollectionID != string(collectionID) {
		return ports.KnowledgeDocument{}, resultUnknown(errors.New("document identity is invalid"))
	}
	status := domain.DocumentStatus(item.Status)
	switch status {
	case domain.DocumentQueued, domain.DocumentPending, domain.DocumentIndexing, domain.DocumentReady, domain.DocumentFailed, domain.DocumentDisabled:
	default:
		return ports.KnowledgeDocument{}, resultUnknown(errors.New("document status is invalid"))
	}
	created, err := time.Parse(time.RFC3339Nano, item.CreatedAt)
	if err != nil {
		return ports.KnowledgeDocument{}, resultUnknown(err)
	}
	updated, err := time.Parse(time.RFC3339Nano, item.UpdatedAt)
	if err != nil {
		return ports.KnowledgeDocument{}, resultUnknown(err)
	}
	return ports.KnowledgeDocument{
		Ref: ports.KnowledgeDocumentRef{ID: id, CollectionID: collectionID}, Name: item.Name,
		MediaType: item.MediaType, Service: item.Service, Tags: item.Tags, Status: status,
		FailureReason: item.FailureReason, Size: item.Size, CreatedAt: created, UpdatedAt: updated,
	}, nil
}
func paginate[T any](items []T, request domain.PageRequest) (domain.Page[T], error) {
	limit := request.Limit
	if limit == 0 {
		limit = 20
	}
	if limit < 1 || limit > 100 {
		return domain.Page[T]{}, invalidArgument(errors.New("page limit must be between 1 and 100"))
	}
	page := 1
	if request.Cursor != "" {
		value, err := strconv.Atoi(request.Cursor)
		if err != nil || value < 1 {
			return domain.Page[T]{}, invalidArgument(errors.New("invalid page cursor"))
		}
		page = value
	}
	start := (page - 1) * limit
	if start >= len(items) {
		return domain.Page[T]{Items: []T{}}, nil
	}
	end := min(start+limit, len(items))
	hasMore := end < len(items)
	next := ""
	if hasMore {
		next = strconv.Itoa(page + 1)
	}
	return domain.Page[T]{Items: items[start:end], HasMore: hasMore, NextCursor: next}, nil
}
func mapProviderError(err error) error {
	if err == nil {
		return nil
	}
	var providerErr *ProviderError
	if !errors.As(err, &providerErr) {
		return &domain.AppError{Code: domain.ErrorProviderUnavailable, Message: "knowledge provider request failed", Cause: err}
	}
	if providerErr.Unknown {
		return resultUnknown(err)
	}
	switch providerErr.Code {
	case "not_found":
		return &domain.AppError{Code: domain.ErrorNotFound, Message: "knowledge resource not found"}
	case "conflict":
		return &domain.AppError{Code: domain.ErrorConflict, Message: "knowledge resource conflicts with current state"}
	case "invalid_argument":
		return invalidArgument(err)
	case "capability_unavailable":
		return &domain.AppError{Code: domain.ErrorCapabilityUnavailable, Message: "knowledge provider capability is unavailable"}
	default:
		return &domain.AppError{Code: domain.ErrorProviderUnavailable, Message: "knowledge provider request failed", Retryable: providerErr.Retryable, Cause: err}
	}
}
func invalidArgument(cause error) error {
	return &domain.AppError{Code: domain.ErrorInvalidArgument, Message: "invalid knowledge request", Cause: cause}
}
func resultUnknown(cause error) error {
	return &domain.AppError{Code: domain.ErrorProviderResultUnknown, Message: "knowledge provider result is unknown", Cause: cause}
}

var _ ports.KnowledgeProvider = (*Provider)(nil)
var _ ports.OwnershipInventoryProvider = (*Provider)(nil)
