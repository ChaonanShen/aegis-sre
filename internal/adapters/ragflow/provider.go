package ragflow

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/1024XEngineer/aegis-sre/internal/adapters/knowledgeid"
	"github.com/1024XEngineer/aegis-sre/internal/domain"
	"github.com/1024XEngineer/aegis-sre/internal/ports"
)

const (
	metadataVersion       = 2
	legacyMetadataVersion = 1
	providerPageSize      = 100
	maxProviderItems      = 1000
	maxReconcileSize      = 20 << 20
)

const (
	metaPublicID     = "aegis_public_id"
	metaOriginalName = "aegis_original_name"
	metaMediaType    = "aegis_media_type"
	metaService      = "aegis_service"
	metaTags         = "aegis_tags"
	metaSHA256       = "aegis_sha256"
	metaScope        = "aegis_scope"
)

type ragflowClient interface {
	ListDatasets(context.Context, int, int, string) (ListDatasetsResult, error)
	CreateDataset(context.Context, string, string, string) (Dataset, error)
	UpdateDataset(context.Context, string, string) error
	DeleteDataset(context.Context, string) error
	ListDocuments(context.Context, string, int, int, string) (ListDocumentsResult, error)
	UploadDocument(context.Context, string, string, string, io.Reader) ([]Document, error)
	UpdateDocument(context.Context, string, string, map[string]any) error
	DeleteDocument(context.Context, string, string) error
	StartIndexing(context.Context, string, string) error
	StopIndexing(context.Context, string, string) error
	ListChunks(context.Context, string, string, int, int) (ListChunksResult, error)
	Retrieve(context.Context, []string, string, int, float64, map[string]any) (RetrievalResult, error)
	DownloadDocument(context.Context, string, string) (*http.Response, error)
}

type Provider struct {
	client         ragflowClient
	ids            *knowledgeid.Codec
	embeddingModel string
}

func NewProvider(client ragflowClient, ids *knowledgeid.Codec, embeddingModel string) (*Provider, error) {
	if client == nil || ids == nil {
		return nil, errors.New("RAGFlow client and knowledge ID codec are required")
	}
	return &Provider{client: client, ids: ids, embeddingModel: strings.TrimSpace(embeddingModel)}, nil
}

func (provider *Provider) Check(ctx context.Context) error {
	_, err := provider.client.ListDatasets(ctx, 1, 1, "")
	return mapProviderError(err)
}

func (provider *Provider) InventoryOwnership(ctx context.Context, base domain.ActorContext, folderUIDs []string) ([]ports.RootResourceOwnership, error) {
	known := make(map[string]string, len(folderUIDs))
	for _, folderUID := range folderUIDs {
		actor := base
		actor.FolderUID = folderUID
		scope, err := provider.ids.ScopeFingerprint(actor)
		if err != nil {
			return nil, invalidArgument(err)
		}
		known[scope] = folderUID
	}
	datasets, err := provider.listAllDatasets(ctx)
	if err != nil {
		return nil, err
	}
	output := make([]ports.RootResourceOwnership, 0)
	for _, dataset := range datasets {
		if !strings.HasPrefix(dataset.Name, "aegis__kbs_") {
			continue
		}
		id, idErr := knowledgeid.PublicIDFromDatasetName(dataset.Name)
		metadata, valid := parseDatasetMetadata(dataset.Description)
		item := ports.RootResourceOwnership{Kind: "knowledge_base", ID: id, State: ports.OwnershipInvalid}
		if idErr == nil && valid {
			switch metadata.Version {
			case legacyMetadataVersion:
				item.OwnerKey, item.State = metadata.Scope, ports.OwnershipLegacy
			case metadataVersion:
				if folderUID := known[metadata.Scope]; folderUID != "" {
					item.FolderUID, item.State = folderUID, ports.OwnershipActive
				} else {
					item.OwnerKey, item.State = metadata.Scope, ports.OwnershipOrphan
				}
			}
		}
		output = append(output, item)
	}
	return output, nil
}

func (provider *Provider) ListCollections(ctx context.Context, actor domain.ActorContext, folderUID string, page domain.PageRequest) (domain.Page[ports.KnowledgeCollection], error) {
	if err := requireScope(actor, folderUID); err != nil {
		return domain.Page[ports.KnowledgeCollection]{}, err
	}
	scope, err := provider.ids.ScopeFingerprint(actor)
	if err != nil {
		return domain.Page[ports.KnowledgeCollection]{}, invalidArgument(err)
	}
	legacyScope, _ := provider.ids.LegacyScopeFingerprint(actor)
	datasets, err := provider.listAllDatasets(ctx)
	if err != nil {
		return domain.Page[ports.KnowledgeCollection]{}, err
	}
	items := make([]ports.KnowledgeCollection, 0)
	for _, dataset := range datasets {
		metadata, ok := parseDatasetMetadata(dataset.Description)
		if !ok {
			if strings.HasPrefix(dataset.Name, "aegis__kbs_") {
				return domain.Page[ports.KnowledgeCollection]{}, unavailable("managed knowledge base metadata is invalid", false, nil)
			}
			continue
		}
		current := metadata.Version == metadataVersion && metadata.Scope == scope
		legacy := metadata.Version == legacyMetadataVersion && metadata.Scope == legacyScope
		if !current && !legacy {
			continue
		}
		collection, mapErr := mapDataset(dataset, metadata, folderUID)
		if mapErr != nil {
			return domain.Page[ports.KnowledgeCollection]{}, mapErr
		}
		items = append(items, collection)
	}
	return paginate(items, page)
}

func (provider *Provider) GetCollection(ctx context.Context, actor domain.ActorContext, ref ports.KnowledgeCollectionRef) (ports.KnowledgeCollection, error) {
	dataset, metadata, err := provider.resolveDataset(ctx, actor, ref, true)
	if err != nil {
		return ports.KnowledgeCollection{}, err
	}
	return mapDataset(dataset, metadata, actor.FolderUID)
}

func (provider *Provider) CreateCollection(ctx context.Context, actor domain.ActorContext, input ports.CreateKnowledgeCollectionInput) (ports.KnowledgeCollection, error) {
	if err := requireScope(actor, input.FolderUID); err != nil {
		return ports.KnowledgeCollection{}, err
	}
	if !input.ID.Valid() || !strings.HasPrefix(string(input.ID), "kbs_") || strings.TrimSpace(input.Name) == "" {
		return ports.KnowledgeCollection{}, invalidArgument(errors.New("valid knowledge base ID and name are required"))
	}
	name, _ := knowledgeid.DatasetName(input.ID)
	scope, _ := provider.ids.ScopeFingerprint(actor)
	metadata := datasetMetadata{Version: metadataVersion, DisplayName: input.Name, Scope: scope, Status: string(domain.KnowledgeBaseActive)}
	existing, findErr := provider.findDatasetByName(ctx, name)
	if findErr != nil && !isNotFound(findErr) {
		return ports.KnowledgeCollection{}, findErr
	}
	if findErr == nil {
		stored, ok := parseDatasetMetadata(existing.Description)
		if !ok || stored.Scope != scope {
			return ports.KnowledgeCollection{}, forbidden("knowledge base scope does not match")
		}
		return mapDataset(existing, stored, actor.FolderUID)
	}
	description, _ := json.Marshal(metadata)
	dataset, err := provider.client.CreateDataset(ctx, name, string(description), provider.embeddingModel)
	if err != nil {
		return ports.KnowledgeCollection{}, mapProviderError(err)
	}
	if dataset.ID == "" {
		return ports.KnowledgeCollection{}, resultUnknown(errors.New("provider returned no dataset identifier"))
	}
	if dataset.Name == "" {
		dataset.Name = name
	}
	if dataset.Description == "" {
		dataset.Description = string(description)
	}
	return mapDataset(dataset, metadata, actor.FolderUID)
}

func (provider *Provider) UpdateCollection(ctx context.Context, actor domain.ActorContext, ref ports.KnowledgeCollectionRef, input ports.UpdateKnowledgeCollectionInput) (ports.KnowledgeCollection, error) {
	dataset, metadata, err := provider.resolveDataset(ctx, actor, ref, false)
	if err != nil {
		return ports.KnowledgeCollection{}, err
	}
	if strings.TrimSpace(input.Name) == "" || (input.Status != domain.KnowledgeBaseActive && input.Status != domain.KnowledgeBaseDisabled) {
		return ports.KnowledgeCollection{}, invalidArgument(errors.New("valid name and status are required"))
	}
	metadata.DisplayName = input.Name
	metadata.Status = string(input.Status)
	description, _ := json.Marshal(metadata)
	if err := provider.client.UpdateDataset(ctx, dataset.ID, string(description)); err != nil {
		return ports.KnowledgeCollection{}, mapProviderError(err)
	}
	return provider.GetCollection(ctx, actor, ref)
}

func (provider *Provider) MigrateCollectionScope(ctx context.Context, actor domain.ActorContext, ref ports.KnowledgeCollectionRef) (ports.KnowledgeCollection, error) {
	dataset, metadata, err := provider.resolveDataset(ctx, actor, ref, true)
	if err != nil {
		return ports.KnowledgeCollection{}, err
	}
	if metadata.Version != legacyMetadataVersion {
		// 数据集元数据最后提交；请求丢失后的重试在这里直接返回成功结果。
		return mapDataset(dataset, metadata, actor.FolderUID)
	}
	targetScope, _ := provider.ids.ScopeFingerprint(actor)
	documents, err := provider.listAllDocuments(ctx, dataset.ID)
	if err != nil {
		return ports.KnowledgeCollection{}, err
	}
	for _, document := range documents {
		publicID := domain.ID(metadataString(document.MetaFields, metaPublicID))
		if !publicID.Valid() || !strings.HasPrefix(string(publicID), "doc_") {
			continue
		}
		documentScope := metadataString(document.MetaFields, metaScope)
		if documentScope == targetScope {
			continue
		}
		if documentScope != metadata.Scope {
			return ports.KnowledgeCollection{}, resultUnknown(errors.New("managed document scope is inconsistent"))
		}
		fields := cloneMetadata(document.MetaFields)
		fields[metaScope] = targetScope
		if err := provider.client.UpdateDocument(ctx, dataset.ID, document.ID, fields); err != nil {
			// 数据集仍保留 legacy scope，管理员可安全重试并继续迁移剩余文档。
			return ports.KnowledgeCollection{}, resultUnknown(err)
		}
	}
	metadata.Version = metadataVersion
	metadata.Scope = targetScope
	description, _ := json.Marshal(metadata)
	if err := provider.client.UpdateDataset(ctx, dataset.ID, string(description)); err != nil {
		return ports.KnowledgeCollection{}, mapProviderError(err)
	}
	return provider.GetCollection(ctx, actor, ref)
}

func (provider *Provider) DeleteCollection(ctx context.Context, actor domain.ActorContext, ref ports.KnowledgeCollectionRef) error {
	dataset, _, err := provider.resolveDataset(ctx, actor, ref, false)
	if err != nil {
		return err
	}
	return mapProviderError(provider.client.DeleteDataset(ctx, dataset.ID))
}

func (provider *Provider) ListDocuments(ctx context.Context, actor domain.ActorContext, ref ports.KnowledgeCollectionRef, page domain.PageRequest) (domain.Page[ports.KnowledgeDocument], error) {
	dataset, metadata, err := provider.resolveDataset(ctx, actor, ref, true)
	if err != nil {
		return domain.Page[ports.KnowledgeDocument]{}, err
	}
	documents, err := provider.listAllDocuments(ctx, dataset.ID)
	if err != nil {
		return domain.Page[ports.KnowledgeDocument]{}, err
	}
	scope := metadata.Scope
	items := make([]ports.KnowledgeDocument, 0, len(documents))
	for _, document := range documents {
		mapped, ok := mapDocument(document, ref.ID, scope)
		if ok {
			items = append(items, mapped)
		}
	}
	return paginate(items, page)
}

func (provider *Provider) GetDocument(ctx context.Context, actor domain.ActorContext, ref ports.KnowledgeDocumentRef) (ports.KnowledgeDocument, error) {
	_, _, mapped, err := provider.resolveDocument(ctx, actor, ref, true)
	return mapped, err
}

func (provider *Provider) UploadDocument(ctx context.Context, actor domain.ActorContext, collectionRef ports.KnowledgeCollectionRef, file ports.DocumentFile) (ports.KnowledgeDocument, error) {
	dataset, _, err := provider.resolveDataset(ctx, actor, collectionRef, false)
	if err != nil {
		return ports.KnowledgeDocument{}, err
	}
	if !file.ID.Valid() || !strings.HasPrefix(string(file.ID), "doc_") || file.Content == nil || strings.TrimSpace(file.Name) == "" || strings.TrimSpace(file.SHA256) == "" {
		return ports.KnowledgeDocument{}, invalidArgument(errors.New("valid document ID, name, digest and content are required"))
	}
	ref := ports.KnowledgeDocumentRef{ID: file.ID, CollectionID: collectionRef.ID}
	providerName, err := knowledgeid.DocumentName(file.ID, file.Name)
	if err != nil {
		return ports.KnowledgeDocument{}, invalidArgument(err)
	}
	metadata, _ := provider.documentMetadata(actor, file)
	if existing, found, reconcileErr := provider.reconcileUpload(ctx, actor, dataset, ref, providerName, file.SHA256, metadata); reconcileErr != nil {
		return ports.KnowledgeDocument{}, reconcileErr
	} else if found {
		return existing, nil
	}
	uploaded, err := provider.client.UploadDocument(ctx, dataset.ID, providerName, file.MediaType, file.Content)
	if err != nil {
		return ports.KnowledgeDocument{}, mapProviderError(err)
	}
	if len(uploaded) != 1 || uploaded[0].ID == "" {
		return ports.KnowledgeDocument{}, resultUnknown(errors.New("provider returned an ambiguous upload result"))
	}
	if err := provider.client.UpdateDocument(ctx, dataset.ID, uploaded[0].ID, metadata); err != nil {
		return ports.KnowledgeDocument{}, resultUnknown(err)
	}
	uploaded[0].MetaFields = metadata
	scope, _ := provider.ids.ScopeFingerprint(actor)
	mapped, ok := mapDocument(uploaded[0], collectionRef.ID, scope)
	if !ok {
		return ports.KnowledgeDocument{}, resultUnknown(errors.New("uploaded document metadata cannot be mapped"))
	}
	return mapped, nil
}

func (provider *Provider) UpdateDocument(ctx context.Context, actor domain.ActorContext, ref ports.KnowledgeDocumentRef, input ports.UpdateKnowledgeDocumentInput) (ports.KnowledgeDocument, error) {
	dataset, document, _, err := provider.resolveDocument(ctx, actor, ref, false)
	if err != nil {
		return ports.KnowledgeDocument{}, err
	}
	metadata := cloneMetadata(document.MetaFields)
	metadata[metaService] = input.Service
	metadata[metaTags] = input.Tags
	if err := provider.client.UpdateDocument(ctx, dataset.ID, document.ID, metadata); err != nil {
		return ports.KnowledgeDocument{}, mapProviderError(err)
	}
	return provider.GetDocument(ctx, actor, ref)
}

func (provider *Provider) StartIndexing(ctx context.Context, actor domain.ActorContext, ref ports.KnowledgeDocumentRef) error {
	dataset, document, _, err := provider.resolveDocument(ctx, actor, ref, false)
	if err != nil {
		return err
	}
	return mapProviderError(provider.client.StartIndexing(ctx, dataset.ID, document.ID))
}

func (provider *Provider) StopIndexing(ctx context.Context, actor domain.ActorContext, ref ports.KnowledgeDocumentRef) error {
	dataset, document, _, err := provider.resolveDocument(ctx, actor, ref, false)
	if err != nil {
		return err
	}
	return mapProviderError(provider.client.StopIndexing(ctx, dataset.ID, document.ID))
}

func (provider *Provider) DeleteDocument(ctx context.Context, actor domain.ActorContext, ref ports.KnowledgeDocumentRef) error {
	dataset, document, _, err := provider.resolveDocument(ctx, actor, ref, false)
	if err != nil {
		return err
	}
	return mapProviderError(provider.client.DeleteDocument(ctx, dataset.ID, document.ID))
}

func (provider *Provider) ListChunks(ctx context.Context, actor domain.ActorContext, ref ports.KnowledgeDocumentRef, page domain.PageRequest) (domain.Page[ports.KnowledgeChunk], error) {
	dataset, document, _, err := provider.resolveDocument(ctx, actor, ref, true)
	if err != nil {
		return domain.Page[ports.KnowledgeChunk]{}, err
	}
	pageNumber, limit, err := providerPage(page)
	if err != nil {
		return domain.Page[ports.KnowledgeChunk]{}, err
	}
	result, err := provider.client.ListChunks(ctx, dataset.ID, document.ID, pageNumber, limit)
	if err != nil {
		return domain.Page[ports.KnowledgeChunk]{}, mapProviderError(err)
	}
	items := make([]ports.KnowledgeChunk, 0, len(result.Items))
	for _, chunk := range result.Items {
		publicChunkID, encodeErr := provider.ids.ChunkID(ref.ID, chunk.ID)
		if encodeErr != nil {
			return domain.Page[ports.KnowledgeChunk]{}, resultUnknown(encodeErr)
		}
		position, chunkPage := mapPosition(chunk.Positions)
		items = append(items, ports.KnowledgeChunk{ID: publicChunkID, Document: ref, Text: chunk.Content, Position: position, PageNumber: chunkPage})
	}
	hasMore := pageNumber*limit < result.Total
	next := ""
	if hasMore {
		next = strconv.Itoa(pageNumber + 1)
	}
	return domain.Page[ports.KnowledgeChunk]{Items: items, HasMore: hasMore, NextCursor: next}, nil
}

func (provider *Provider) DownloadDocument(ctx context.Context, actor domain.ActorContext, ref ports.KnowledgeDocumentRef) (ports.KnowledgeDocumentDownload, error) {
	dataset, document, mapped, err := provider.resolveDocument(ctx, actor, ref, true)
	if err != nil {
		return ports.KnowledgeDocumentDownload{}, err
	}
	response, err := provider.client.DownloadDocument(ctx, dataset.ID, document.ID)
	if err != nil {
		return ports.KnowledgeDocumentDownload{}, mapProviderError(err)
	}
	return ports.KnowledgeDocumentDownload{Name: mapped.Name, MediaType: mapped.MediaType, Size: mapped.Size, Content: response.Body}, nil
}

func (provider *Provider) Retrieve(ctx context.Context, actor domain.ActorContext, input ports.RetrievalInput) ([]ports.RetrievalHit, error) {
	if strings.TrimSpace(input.Query) == "" || len(input.Collections) == 0 || input.Limit < 1 || input.Limit > 20 || input.Threshold < 0 || input.Threshold > 1 {
		return nil, invalidArgument(errors.New("invalid knowledge retrieval input"))
	}
	datasetIDs := make([]string, 0, len(input.Collections))
	documentIndex := make(map[string]ports.KnowledgeDocument)
	if _, err := provider.ids.ScopeFingerprint(actor); err != nil {
		return nil, invalidArgument(err)
	}
	for _, collection := range input.Collections {
		dataset, collectionMetadata, resolveErr := provider.resolveDataset(ctx, actor, collection, true)
		if resolveErr != nil {
			return nil, resolveErr
		}
		if collectionMetadata.Status == string(domain.KnowledgeBaseDisabled) {
			return nil, conflict("disabled knowledge base cannot be searched")
		}
		datasetIDs = append(datasetIDs, dataset.ID)
		documents, listErr := provider.listAllDocuments(ctx, dataset.ID)
		if listErr != nil {
			return nil, listErr
		}
		for _, document := range documents {
			if mapped, ok := mapDocument(document, collection.ID, collectionMetadata.Scope); ok {
				documentIndex[dataset.ID+"\x00"+document.ID] = mapped
			}
		}
	}
	var metadata map[string]any
	if input.Service != "" {
		metadata = map[string]any{"logic": "and", "conditions": []map[string]any{{"name": metaService, "comparison_operator": "=", "value": input.Service}}}
	}
	result, err := provider.client.Retrieve(ctx, datasetIDs, input.Query, input.Limit, input.Threshold, metadata)
	if err != nil {
		return nil, mapProviderError(err)
	}
	hits := make([]ports.RetrievalHit, 0, len(result.Chunks))
	for _, chunk := range result.Chunks {
		document, ok := documentIndex[chunk.KnowledgeBaseID+"\x00"+chunk.DocumentID]
		if !ok {
			continue
		}
		position, pageNumber := mapPosition(chunk.Positions)
		hits = append(hits, ports.RetrievalHit{Document: document.Ref, SourceName: document.Name, Text: chunk.Content, Score: chunk.Similarity, Position: position, PageNumber: pageNumber})
		if len(hits) == input.Limit {
			break
		}
	}
	return hits, nil
}

type datasetMetadata struct {
	Version     int    `json:"aegis_version"`
	DisplayName string `json:"display_name"`
	Scope       string `json:"scope"`
	Status      string `json:"status,omitempty"`
}

func parseDatasetMetadata(value string) (datasetMetadata, bool) {
	var metadata datasetMetadata
	if err := json.Unmarshal([]byte(value), &metadata); err != nil || (metadata.Version != metadataVersion && metadata.Version != legacyMetadataVersion) || metadata.DisplayName == "" || metadata.Scope == "" {
		return datasetMetadata{}, false
	}
	return metadata, true
}

func mapDataset(dataset Dataset, metadata datasetMetadata, folderUID string) (ports.KnowledgeCollection, error) {
	publicID, err := knowledgeid.PublicIDFromDatasetName(dataset.Name)
	if err != nil {
		return ports.KnowledgeCollection{}, resultUnknown(err)
	}
	status := domain.KnowledgeBaseStatus(metadata.Status)
	if status == "" {
		status = domain.KnowledgeBaseActive
	}
	if status != domain.KnowledgeBaseActive && status != domain.KnowledgeBaseDisabled {
		return ports.KnowledgeCollection{}, resultUnknown(errors.New("managed knowledge base status is invalid"))
	}
	if dataset.Status == "0" {
		status = domain.KnowledgeBaseDisabled
	}
	return ports.KnowledgeCollection{Ref: ports.KnowledgeCollectionRef{ID: publicID}, Name: metadata.DisplayName, FolderUID: folderUID, Status: status, CreatedAt: millis(dataset.CreateTime), UpdatedAt: millis(dataset.UpdateTime), ReadOnly: metadata.Version == legacyMetadataVersion}, nil
}

func mapDocument(document Document, collectionID domain.ID, scope string) (ports.KnowledgeDocument, bool) {
	if metadataString(document.MetaFields, metaScope) != scope {
		return ports.KnowledgeDocument{}, false
	}
	publicID := domain.ID(metadataString(document.MetaFields, metaPublicID))
	if !publicID.Valid() || !strings.HasPrefix(string(publicID), "doc_") {
		return ports.KnowledgeDocument{}, false
	}
	status := mapDocumentStatus(document.Run)
	failureReason := ""
	if status == domain.DocumentFailed {
		failureReason = "document parsing failed"
	}
	return ports.KnowledgeDocument{
		Ref:  ports.KnowledgeDocumentRef{ID: publicID, CollectionID: collectionID},
		Name: metadataString(document.MetaFields, metaOriginalName), MediaType: metadataString(document.MetaFields, metaMediaType),
		Service: metadataString(document.MetaFields, metaService), Tags: metadataStrings(document.MetaFields[metaTags]), Status: status,
		FailureReason: failureReason, Size: document.Size, CreatedAt: millis(document.CreateTime), UpdatedAt: millis(document.UpdateTime),
	}, true
}

func mapDocumentStatus(run string) domain.DocumentStatus {
	switch strings.ToUpper(run) {
	case "RUNNING", "1":
		return domain.DocumentIndexing
	case "DONE", "3":
		return domain.DocumentReady
	case "FAIL", "4":
		return domain.DocumentFailed
	case "CANCEL", "2":
		return domain.DocumentDisabled
	default:
		return domain.DocumentPending
	}
}

func (provider *Provider) resolveDataset(ctx context.Context, actor domain.ActorContext, ref ports.KnowledgeCollectionRef, allowLegacy bool) (Dataset, datasetMetadata, error) {
	if err := requireScope(actor, actor.FolderUID); err != nil {
		return Dataset{}, datasetMetadata{}, err
	}
	name, err := knowledgeid.DatasetName(ref.ID)
	if err != nil {
		return Dataset{}, datasetMetadata{}, invalidArgument(err)
	}
	dataset, err := provider.findDatasetByName(ctx, name)
	if err != nil {
		return Dataset{}, datasetMetadata{}, err
	}
	metadata, ok := parseDatasetMetadata(dataset.Description)
	if !ok {
		return Dataset{}, datasetMetadata{}, notFound("knowledge base not found")
	}
	scope, _ := provider.ids.ScopeFingerprint(actor)
	current := metadata.Version == metadataVersion && metadata.Scope == scope
	legacyScope, _ := provider.ids.LegacyScopeFingerprint(actor)
	legacy := allowLegacy && metadata.Version == legacyMetadataVersion && metadata.Scope == legacyScope
	if !current && !legacy {
		return Dataset{}, datasetMetadata{}, forbidden("knowledge base scope does not match")
	}
	return dataset, metadata, nil
}

func (provider *Provider) findDatasetByName(ctx context.Context, name string) (Dataset, error) {
	result, err := provider.client.ListDatasets(ctx, 1, 2, name)
	if err != nil {
		return Dataset{}, mapProviderError(err)
	}
	var found *Dataset
	for index := range result.Items {
		if result.Items[index].Name != name {
			continue
		}
		if found != nil {
			return Dataset{}, conflict("duplicate managed knowledge base")
		}
		copy := result.Items[index]
		found = &copy
	}
	if found == nil {
		return Dataset{}, notFound("knowledge base not found")
	}
	return *found, nil
}

func (provider *Provider) resolveDocument(ctx context.Context, actor domain.ActorContext, ref ports.KnowledgeDocumentRef, allowLegacy bool) (Dataset, Document, ports.KnowledgeDocument, error) {
	dataset, metadata, err := provider.resolveDataset(ctx, actor, ports.KnowledgeCollectionRef{ID: ref.CollectionID}, allowLegacy)
	if err != nil {
		return Dataset{}, Document{}, ports.KnowledgeDocument{}, err
	}
	return provider.resolveDocumentInDataset(ctx, dataset, ref, metadata.Scope)
}

func (provider *Provider) resolveDocumentInDataset(ctx context.Context, dataset Dataset, ref ports.KnowledgeDocumentRef, scope string) (Dataset, Document, ports.KnowledgeDocument, error) {
	if !ref.ID.Valid() || !strings.HasPrefix(string(ref.ID), "doc_") {
		return Dataset{}, Document{}, ports.KnowledgeDocument{}, invalidArgument(errors.New("invalid document ID"))
	}
	documents, err := provider.listAllDocuments(ctx, dataset.ID)
	if err != nil {
		return Dataset{}, Document{}, ports.KnowledgeDocument{}, err
	}
	for _, document := range documents {
		if metadataString(document.MetaFields, metaPublicID) != string(ref.ID) {
			continue
		}
		mapped, ok := mapDocument(document, ref.CollectionID, scope)
		if !ok {
			return Dataset{}, Document{}, ports.KnowledgeDocument{}, forbidden("document scope does not match")
		}
		return dataset, document, mapped, nil
	}
	return Dataset{}, Document{}, ports.KnowledgeDocument{}, notFound("document not found")
}

func (provider *Provider) documentMetadata(actor domain.ActorContext, file ports.DocumentFile) (map[string]any, error) {
	scope, err := provider.ids.ScopeFingerprint(actor)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		metaPublicID: string(file.ID), metaOriginalName: file.Name, metaMediaType: file.MediaType,
		metaService: file.Service, metaTags: file.Tags, metaSHA256: file.SHA256, metaScope: scope,
	}, nil
}

// reconcileUpload repairs the only uncertain two-step mutation: file upload succeeded but metadata update did not.
func (provider *Provider) reconcileUpload(ctx context.Context, actor domain.ActorContext, dataset Dataset, ref ports.KnowledgeDocumentRef, providerName, expectedDigest string, metadata map[string]any) (ports.KnowledgeDocument, bool, error) {
	documents, err := provider.listAllDocuments(ctx, dataset.ID)
	if err != nil {
		return ports.KnowledgeDocument{}, false, err
	}
	scope, _ := provider.ids.ScopeFingerprint(actor)
	prefix := strings.TrimSuffix(providerName, strings.ToLower(filepathExtension(providerName)))
	var candidate *Document
	for index := range documents {
		document := &documents[index]
		isPublicMatch := metadataString(document.MetaFields, metaPublicID) == string(ref.ID)
		isCanonicalOrphan := strings.HasPrefix(document.Name, prefix) || strings.HasPrefix(document.Location, prefix)
		if !isPublicMatch && !isCanonicalOrphan {
			continue
		}
		storedScope := metadataString(document.MetaFields, metaScope)
		if storedScope != "" && storedScope != scope {
			return ports.KnowledgeDocument{}, false, forbidden("document scope does not match")
		}
		if candidate != nil {
			return ports.KnowledgeDocument{}, false, conflict("duplicate managed document")
		}
		candidate = document
	}
	if candidate == nil {
		return ports.KnowledgeDocument{}, false, nil
	}
	storedDigest := existingDigest(*candidate)
	if storedDigest == "" {
		response, downloadErr := provider.client.DownloadDocument(ctx, dataset.ID, candidate.ID)
		if downloadErr != nil {
			return ports.KnowledgeDocument{}, false, mapProviderError(downloadErr)
		}
		hash := sha256.New()
		written, copyErr := io.Copy(hash, io.LimitReader(response.Body, maxReconcileSize+1))
		closeErr := response.Body.Close()
		if copyErr != nil || closeErr != nil || written > maxReconcileSize {
			return ports.KnowledgeDocument{}, false, resultUnknown(errors.New("cannot verify uncertain document upload"))
		}
		storedDigest = hex.EncodeToString(hash.Sum(nil))
	}
	if !strings.EqualFold(storedDigest, expectedDigest) {
		return ports.KnowledgeDocument{}, false, conflict("idempotency key was already used for different content")
	}
	if metadataString(candidate.MetaFields, metaPublicID) == "" {
		if updateErr := provider.client.UpdateDocument(ctx, dataset.ID, candidate.ID, metadata); updateErr != nil {
			return ports.KnowledgeDocument{}, false, resultUnknown(updateErr)
		}
		candidate.MetaFields = cloneMetadata(metadata)
	}
	mapped, ok := mapDocument(*candidate, ref.CollectionID, scope)
	if !ok {
		return ports.KnowledgeDocument{}, false, resultUnknown(errors.New("reconciled document metadata cannot be mapped"))
	}
	return mapped, true, nil
}

func filepathExtension(name string) string {
	lastDot := strings.LastIndexByte(name, '.')
	if lastDot < 0 {
		return ""
	}
	return name[lastDot:]
}

func (provider *Provider) listAllDatasets(ctx context.Context) ([]Dataset, error) {
	items := make([]Dataset, 0)
	for page := 1; ; page++ {
		result, err := provider.client.ListDatasets(ctx, page, providerPageSize, "")
		if err != nil {
			return nil, mapProviderError(err)
		}
		items = append(items, result.Items...)
		if len(items) > maxProviderItems {
			return nil, unavailable("knowledge provider resource limit exceeded", false, nil)
		}
		if len(items) >= result.Total || len(result.Items) == 0 {
			return items, nil
		}
	}
}

func (provider *Provider) listAllDocuments(ctx context.Context, datasetID string) ([]Document, error) {
	items := make([]Document, 0)
	for page := 1; ; page++ {
		result, err := provider.client.ListDocuments(ctx, datasetID, page, providerPageSize, "")
		if err != nil {
			return nil, mapProviderError(err)
		}
		items = append(items, result.Items...)
		if len(items) > maxProviderItems {
			return nil, unavailable("knowledge provider resource limit exceeded", false, nil)
		}
		if len(items) >= result.Total || len(result.Items) == 0 {
			return items, nil
		}
	}
}

func requireScope(actor domain.ActorContext, folderUID string) error {
	if err := actor.Validate(); err != nil {
		return &domain.AppError{Code: domain.ErrorUnauthenticated, Message: "trusted actor context is required", Cause: err}
	}
	if actor.FolderUID == "" || folderUID == "" {
		return forbidden("trusted folder context is required")
	}
	if actor.FolderUID != folderUID {
		return forbidden("folder context does not match")
	}
	return nil
}

func providerPage(page domain.PageRequest) (int, int, error) {
	limit := page.Limit
	if limit == 0 {
		limit = 20
	}
	if limit < 1 || limit > 100 {
		return 0, 0, invalidArgument(errors.New("page limit must be between 1 and 100"))
	}
	pageNumber := 1
	if page.Cursor != "" {
		parsed, err := strconv.Atoi(page.Cursor)
		if err != nil || parsed < 1 {
			return 0, 0, invalidArgument(errors.New("invalid page cursor"))
		}
		pageNumber = parsed
	}
	return pageNumber, limit, nil
}

func paginate[T any](items []T, request domain.PageRequest) (domain.Page[T], error) {
	page, limit, err := providerPage(request)
	if err != nil {
		return domain.Page[T]{}, err
	}
	start := (page - 1) * limit
	if start >= len(items) {
		return domain.Page[T]{Items: []T{}}, nil
	}
	end := start + limit
	if end > len(items) {
		end = len(items)
	}
	hasMore := end < len(items)
	next := ""
	if hasMore {
		next = strconv.Itoa(page + 1)
	}
	return domain.Page[T]{Items: items[start:end], HasMore: hasMore, NextCursor: next}, nil
}

func metadataString(metadata map[string]any, key string) string {
	value, _ := metadata[key].(string)
	return value
}

func metadataStrings(value any) []string {
	switch typed := value.(type) {
	case []string:
		return append([]string(nil), typed...)
	case []any:
		values := make([]string, 0, len(typed))
		for _, item := range typed {
			if text, ok := item.(string); ok {
				values = append(values, text)
			}
		}
		return values
	default:
		return []string{}
	}
}

func cloneMetadata(source map[string]any) map[string]any {
	target := make(map[string]any, len(source))
	for key, value := range source {
		target[key] = value
	}
	return target
}

func existingDigest(document Document) string {
	// Digest is only used during reconciliation and intentionally does not enter the public resource.
	return metadataString(document.MetaFields, metaSHA256)
}

func millis(value int64) time.Time {
	if value <= 0 {
		return time.Time{}
	}
	return time.UnixMilli(value).UTC()
}

func mapPosition(positions []any) (string, int) {
	if len(positions) == 0 {
		return "", 0
	}
	encoded, _ := json.Marshal(positions)
	position := string(encoded)
	if len(position) > 512 {
		position = position[:512]
	}
	page := 0
	if first, ok := positions[0].([]any); ok && len(first) > 0 {
		switch value := first[0].(type) {
		case float64:
			page = int(value)
		case int:
			page = value
		}
	}
	return position, page
}

func mapProviderError(err error) error {
	if err == nil {
		return nil
	}
	var providerErr *ProviderError
	if errors.As(err, &providerErr) {
		if providerErr.Unknown {
			return resultUnknown(err)
		}
		return unavailable("knowledge provider request failed", providerErr.Retryable, err)
	}
	var appErr *domain.AppError
	if errors.As(err, &appErr) {
		return err
	}
	return unavailable("knowledge provider request failed", false, err)
}

func invalidArgument(cause error) error {
	return &domain.AppError{Code: domain.ErrorInvalidArgument, Message: "invalid knowledge request", Cause: cause}
}
func forbidden(message string) error {
	return &domain.AppError{Code: domain.ErrorForbidden, Message: message}
}
func notFound(message string) error {
	return &domain.AppError{Code: domain.ErrorNotFound, Message: message}
}
func conflict(message string) error {
	return &domain.AppError{Code: domain.ErrorConflict, Message: message}
}
func resultUnknown(cause error) error {
	return &domain.AppError{Code: domain.ErrorProviderResultUnknown, Message: "knowledge provider result is unknown", Cause: cause}
}
func unavailable(message string, retryable bool, cause error) error {
	return &domain.AppError{Code: domain.ErrorProviderUnavailable, Message: message, Retryable: retryable, Cause: cause}
}
func isNotFound(err error) bool {
	var appErr *domain.AppError
	return errors.As(err, &appErr) && appErr.Code == domain.ErrorNotFound
}

var _ ports.KnowledgeProvider = (*Provider)(nil)
var _ ports.OwnershipInventoryProvider = (*Provider)(nil)
