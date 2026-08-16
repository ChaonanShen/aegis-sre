package ragflow

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/1024XEngineer/aegis-sre/internal/adapters/knowledgeid"
	"github.com/1024XEngineer/aegis-sre/internal/domain"
	"github.com/1024XEngineer/aegis-sre/internal/ports"
)

func TestListCollectionsFiltersUnmanagedAndOtherScopes(t *testing.T) {
	provider, fake, codec, actor := newTestProvider(t)
	ownedID, _ := codec.CollectionID(actor, "owned")
	other := actor
	other.FolderUID = "folder-b"
	otherScope, _ := codec.ScopeFingerprint(other)
	ownedScope, _ := codec.ScopeFingerprint(actor)
	fake.datasets = []Dataset{
		testDataset(t, ownedID, "Owned", ownedScope),
		{Name: "customer-dataset", Description: "not Aegis metadata"},
		testDataset(t, domain.ID("kbs_ijklmnop"), "Other", otherScope),
	}

	page, err := provider.ListCollections(context.Background(), actor, actor.FolderUID, domain.PageRequest{Limit: 20})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || page.Items[0].Ref.ID != ownedID || page.Items[0].Name != "Owned" {
		t.Fatalf("page = %+v", page)
	}
	if _, err := provider.ListCollections(context.Background(), actor, "folder-b", domain.PageRequest{}); appCode(err) != domain.ErrorForbidden {
		t.Fatalf("cross-folder error = %#v", err)
	}
}

func TestListCollectionsDoesNotSilentlyHideCorruptManagedMetadata(t *testing.T) {
	provider, fake, _, actor := newTestProvider(t)
	fake.datasets = []Dataset{{ID: "internal", Name: "aegis__kbs_abcdefgh", Description: `{"scope":"missing-version"}`}}
	_, err := provider.ListCollections(context.Background(), actor, actor.FolderUID, domain.PageRequest{})
	if appCode(err) != domain.ErrorProviderUnavailable {
		t.Fatalf("error = %#v", err)
	}
}

func TestCreateCollectionReconcilesByCanonicalName(t *testing.T) {
	provider, fake, codec, actor := newTestProvider(t)
	id, _ := codec.CollectionID(actor, "create")
	scope, _ := codec.ScopeFingerprint(actor)
	fake.datasets = []Dataset{testDataset(t, id, "Existing", scope)}

	collection, err := provider.CreateCollection(context.Background(), actor, ports.CreateKnowledgeCollectionInput{ID: id, Name: "Ignored retry name", FolderUID: actor.FolderUID})
	if err != nil {
		t.Fatal(err)
	}
	if fake.createCalls != 0 || collection.Name != "Existing" {
		t.Fatalf("create calls=%d collection=%+v", fake.createCalls, collection)
	}

	fake.datasets = nil
	collection, err = provider.CreateCollection(context.Background(), actor, ports.CreateKnowledgeCollectionInput{ID: id, Name: "新知识库", FolderUID: actor.FolderUID})
	if err != nil {
		t.Fatal(err)
	}
	if fake.createCalls != 1 || fake.createdName != "aegis__"+string(id) || fake.embeddingModel != "Qwen3-Embedding-0.6B@OpenAI-API-Compatible" {
		t.Fatalf("create = %d %q %q", fake.createCalls, fake.createdName, fake.embeddingModel)
	}
	if strings.Contains(fake.createdDescription, actor.UserID) || collection.Name != "新知识库" {
		t.Fatalf("description or mapped collection leaked scope: %q %+v", fake.createdDescription, collection)
	}
}

func TestUploadStoresMetadataAndReconcilesDigest(t *testing.T) {
	provider, fake, codec, actor := newTestProvider(t)
	collectionID, _ := codec.CollectionID(actor, "kb")
	documentID, _ := codec.DocumentID(collectionID, "doc")
	scope, _ := codec.ScopeFingerprint(actor)
	fake.datasets = []Dataset{testDataset(t, collectionID, "KB", scope)}
	file := ports.DocumentFile{ID: documentID, Name: "私有故障手册.PDF", MediaType: "application/pdf", Service: "checkout", Tags: []string{"sev1"}, SHA256: "abc123", Content: strings.NewReader("bytes")}

	document, err := provider.UploadDocument(context.Background(), actor, ports.KnowledgeCollectionRef{ID: collectionID}, file)
	if err != nil {
		t.Fatal(err)
	}
	if fake.uploadCalls != 1 || fake.uploadName != "aegis__"+string(documentID)+".pdf" || fake.updatedMetadata[metaPublicID] != string(documentID) || fake.updatedMetadata[metaOriginalName] != file.Name {
		t.Fatalf("upload=%d name=%q metadata=%+v", fake.uploadCalls, fake.uploadName, fake.updatedMetadata)
	}
	if document.Name != file.Name || document.Service != "checkout" || len(document.Tags) != 1 {
		t.Fatalf("document = %+v", document)
	}

	fake.documents = []Document{fake.uploadedDocument}
	file.Content = strings.NewReader("bytes")
	_, err = provider.UploadDocument(context.Background(), actor, ports.KnowledgeCollectionRef{ID: collectionID}, file)
	if err != nil || fake.uploadCalls != 1 {
		t.Fatalf("idempotent upload calls=%d error=%v", fake.uploadCalls, err)
	}
	file.SHA256 = "different"
	file.Content = strings.NewReader("other")
	if _, err := provider.UploadDocument(context.Background(), actor, ports.KnowledgeCollectionRef{ID: collectionID}, file); appCode(err) != domain.ErrorConflict {
		t.Fatalf("digest conflict = %#v", err)
	}
}

func TestUploadMetadataFailureReportsUnknownWithoutRetry(t *testing.T) {
	provider, fake, codec, actor := newTestProvider(t)
	collectionID, _ := codec.CollectionID(actor, "kb")
	documentID, _ := codec.DocumentID(collectionID, "doc")
	scope, _ := codec.ScopeFingerprint(actor)
	fake.datasets = []Dataset{testDataset(t, collectionID, "KB", scope)}
	fake.updateDocumentErr = errors.New("write failed after upload")

	_, err := provider.UploadDocument(context.Background(), actor, ports.KnowledgeCollectionRef{ID: collectionID}, ports.DocumentFile{
		ID: documentID, Name: "runbook.md", MediaType: "text/markdown", SHA256: "sha", Content: strings.NewReader("body"),
	})
	if appCode(err) != domain.ErrorProviderResultUnknown || fake.uploadCalls != 1 || fake.updateDocumentCalls != 1 {
		t.Fatalf("error=%#v upload=%d metadata=%d", err, fake.uploadCalls, fake.updateDocumentCalls)
	}
}

func TestUploadRetryRepairsCanonicalOrphanAfterDigestVerification(t *testing.T) {
	provider, fake, codec, actor := newTestProvider(t)
	collectionID, _ := codec.CollectionID(actor, "kb")
	documentID, _ := codec.DocumentID(collectionID, "doc")
	scope, _ := codec.ScopeFingerprint(actor)
	fake.datasets = []Dataset{testDataset(t, collectionID, "KB", scope)}
	fake.documents = []Document{{ID: "orphan-internal", Name: "aegis__" + string(documentID) + ".md", Location: "aegis__" + string(documentID) + ".md"}}
	fake.downloadBody = "orphan bytes"
	digest := sha256.Sum256([]byte(fake.downloadBody))

	document, err := provider.UploadDocument(context.Background(), actor, ports.KnowledgeCollectionRef{ID: collectionID}, ports.DocumentFile{
		ID: documentID, Name: "guide.md", MediaType: "text/markdown", SHA256: hex.EncodeToString(digest[:]), Content: strings.NewReader(fake.downloadBody),
	})
	if err != nil {
		t.Fatal(err)
	}
	if fake.uploadCalls != 0 || fake.updateDocumentCalls != 1 || document.Ref.ID != documentID {
		t.Fatalf("upload=%d metadata=%d document=%+v", fake.uploadCalls, fake.updateDocumentCalls, document)
	}
}

func TestRetrieveMapsOnlyAuthorizedDocumentsAndFixedServiceFilter(t *testing.T) {
	provider, fake, codec, actor := newTestProvider(t)
	collectionID, _ := codec.CollectionID(actor, "kb")
	documentID, _ := codec.DocumentID(collectionID, "doc")
	scope, _ := codec.ScopeFingerprint(actor)
	fake.datasets = []Dataset{testDataset(t, collectionID, "KB", scope)}
	fake.documents = []Document{{ID: "internal-doc", Run: "DONE", MetaFields: testDocumentMetadata(documentID, "guide.md", "text/markdown", "checkout", scope, "sha")}}
	fake.retrieval = RetrievalResult{Chunks: []RetrievalChunk{
		{KnowledgeBaseID: "internal-" + string(collectionID), DocumentID: "foreign-doc", Content: "must be dropped", Similarity: 1},
		{KnowledgeBaseID: "internal-" + string(collectionID), DocumentID: "internal-doc", Content: "restart the checkout worker", Similarity: .91, Positions: []any{[]any{float64(3), float64(10)}}},
	}}

	hits, err := provider.Retrieve(context.Background(), actor, ports.RetrievalInput{Query: "how to restart", Collections: []ports.KnowledgeCollectionRef{{ID: collectionID}}, Service: "checkout", Limit: 5, Threshold: .2})
	if err != nil {
		t.Fatal(err)
	}
	if len(hits) != 1 || hits[0].Document.ID != documentID || hits[0].SourceName != "guide.md" || hits[0].PageNumber != 3 {
		t.Fatalf("hits = %+v", hits)
	}
	encoded, _ := json.Marshal(fake.retrievalMetadata)
	if !strings.Contains(string(encoded), `"name":"aegis_service"`) || strings.Contains(string(encoded), "metadata_condition") {
		t.Fatalf("metadata filter = %s", encoded)
	}
}

func TestRetrieveRejectsDisabledCollection(t *testing.T) {
	provider, fake, codec, actor := newTestProvider(t)
	collectionID, _ := codec.CollectionID(actor, "kb")
	scope, _ := codec.ScopeFingerprint(actor)
	dataset := testDataset(t, collectionID, "KB", scope)
	metadata, _ := parseDatasetMetadata(dataset.Description)
	metadata.Status = string(domain.KnowledgeBaseDisabled)
	description, _ := json.Marshal(metadata)
	dataset.Description = string(description)
	fake.datasets = []Dataset{dataset}

	_, err := provider.Retrieve(context.Background(), actor, ports.RetrievalInput{Query: "q", Collections: []ports.KnowledgeCollectionRef{{ID: collectionID}}, Limit: 5, Threshold: .2})
	if appCode(err) != domain.ErrorConflict {
		t.Fatalf("error = %#v", err)
	}
}

func TestCrossFolderScopeRejectsEveryCollectionAndDocumentOperation(t *testing.T) {
	provider, fake, codec, owner := newTestProvider(t)
	collectionID, _ := codec.CollectionID(owner, "kb")
	documentID, _ := codec.DocumentID(collectionID, "doc")
	ownerScope, _ := codec.ScopeFingerprint(owner)
	fake.datasets = []Dataset{testDataset(t, collectionID, "KB", ownerScope)}
	fake.documents = []Document{{ID: "internal-doc", MetaFields: testDocumentMetadata(documentID, "guide.md", "text/markdown", "checkout", ownerScope, "sha")}}
	other := owner
	other.FolderUID = "folder-b"
	collectionRef := ports.KnowledgeCollectionRef{ID: collectionID}
	documentRef := ports.KnowledgeDocumentRef{ID: documentID, CollectionID: collectionID}

	tests := map[string]func() error{
		"collection detail": func() error {
			_, err := provider.GetCollection(context.Background(), other, collectionRef)
			return err
		},
		"collection update": func() error {
			_, err := provider.UpdateCollection(context.Background(), other, collectionRef, ports.UpdateKnowledgeCollectionInput{Name: "renamed"})
			return err
		},
		"collection delete": func() error {
			return provider.DeleteCollection(context.Background(), other, collectionRef)
		},
		"document list": func() error {
			_, err := provider.ListDocuments(context.Background(), other, collectionRef, domain.PageRequest{})
			return err
		},
		"document detail": func() error {
			_, err := provider.GetDocument(context.Background(), other, documentRef)
			return err
		},
		"document upload": func() error {
			_, err := provider.UploadDocument(context.Background(), other, collectionRef, ports.DocumentFile{ID: documentID, Name: "guide.md", SHA256: "sha", Content: strings.NewReader("body")})
			return err
		},
		"document update": func() error {
			_, err := provider.UpdateDocument(context.Background(), other, documentRef, ports.UpdateKnowledgeDocumentInput{Service: "payments"})
			return err
		},
		"document index": func() error {
			return provider.StartIndexing(context.Background(), other, documentRef)
		},
		"document stop": func() error {
			return provider.StopIndexing(context.Background(), other, documentRef)
		},
		"document delete": func() error {
			return provider.DeleteDocument(context.Background(), other, documentRef)
		},
		"chunk list": func() error {
			_, err := provider.ListChunks(context.Background(), other, documentRef, domain.PageRequest{})
			return err
		},
		"document download": func() error {
			_, err := provider.DownloadDocument(context.Background(), other, documentRef)
			return err
		},
		"retrieval": func() error {
			_, err := provider.Retrieve(context.Background(), other, ports.RetrievalInput{Query: "restart", Collections: []ports.KnowledgeCollectionRef{collectionRef}, Limit: 5})
			return err
		},
	}

	for name, invoke := range tests {
		t.Run(name, func(t *testing.T) {
			if err := invoke(); appCode(err) != domain.ErrorForbidden {
				t.Fatalf("error = %#v", err)
			}
		})
	}
	if fake.uploadCalls != 0 || fake.updateDocumentCalls != 0 {
		t.Fatalf("forbidden requests reached provider mutations: upload=%d update=%d", fake.uploadCalls, fake.updateDocumentCalls)
	}
}

func TestFolderScopedKnowledgeIsSharedAcrossUsers(t *testing.T) {
	provider, fake, codec, owner := newTestProvider(t)
	collectionID, _ := codec.CollectionID(owner, "kb")
	scope, _ := codec.ScopeFingerprint(owner)
	fake.datasets = []Dataset{testDataset(t, collectionID, "Shared", scope)}
	otherUser := owner
	otherUser.UserID = "other-user"

	collection, err := provider.GetCollection(context.Background(), otherUser, ports.KnowledgeCollectionRef{ID: collectionID})
	if err != nil || collection.Name != "Shared" || collection.FolderUID != owner.FolderUID {
		t.Fatalf("shared collection = %#v, err = %v", collection, err)
	}
}

func TestLegacyUserScopedKnowledgeIsCreatorReadOnly(t *testing.T) {
	provider, fake, codec, owner := newTestProvider(t)
	collectionID := domain.ID("kbs_legacy12345")
	documentID := domain.ID("doc_legacy12345")
	legacyScope, _ := codec.LegacyScopeFingerprint(owner)
	dataset := testDataset(t, collectionID, "Legacy", legacyScope)
	var metadata datasetMetadata
	_ = json.Unmarshal([]byte(dataset.Description), &metadata)
	metadata.Version = legacyMetadataVersion
	dataset.Description = mustJSON(metadata)
	fake.datasets = []Dataset{dataset}
	fake.documents = []Document{{ID: "internal-doc", Name: "legacy.md", Size: 4, MetaFields: testDocumentMetadata(documentID, "legacy.md", "text/markdown", "", legacyScope, "sha")}}
	collectionRef := ports.KnowledgeCollectionRef{ID: collectionID}
	documentRef := ports.KnowledgeDocumentRef{ID: documentID, CollectionID: collectionID}

	if _, err := provider.GetCollection(context.Background(), owner, collectionRef); err != nil {
		t.Fatalf("legacy creator read failed: %v", err)
	}
	if _, err := provider.GetDocument(context.Background(), owner, documentRef); err != nil {
		t.Fatalf("legacy document read failed: %v", err)
	}
	otherUser := owner
	otherUser.UserID = "other-user"
	if _, err := provider.GetCollection(context.Background(), otherUser, collectionRef); appCode(err) != domain.ErrorForbidden {
		t.Fatalf("legacy collection escaped creator: %#v", err)
	}
	if _, err := provider.UpdateCollection(context.Background(), owner, collectionRef, ports.UpdateKnowledgeCollectionInput{Name: "changed", Status: domain.KnowledgeBaseActive}); appCode(err) != domain.ErrorForbidden {
		t.Fatalf("legacy collection update error = %#v", err)
	}
	if _, err := provider.UploadDocument(context.Background(), owner, collectionRef, ports.DocumentFile{ID: "doc_new12345", Name: "new.md", SHA256: "sha", Content: strings.NewReader("body")}); appCode(err) != domain.ErrorForbidden {
		t.Fatalf("legacy upload error = %#v", err)
	}
	if fake.updateDatasetCalls != 0 || fake.uploadCalls != 0 {
		t.Fatalf("legacy writes reached Provider: update=%d upload=%d", fake.updateDatasetCalls, fake.uploadCalls)
	}
}

func TestLegacyScopeMigrationUpdatesDocumentsBeforeDatasetCommit(t *testing.T) {
	provider, fake, codec, actor := newTestProvider(t)
	collectionID := domain.ID("kbs_legacy12345")
	documentID := domain.ID("doc_legacy12345")
	legacyScope, _ := codec.LegacyScopeFingerprint(actor)
	targetScope, _ := codec.ScopeFingerprint(actor)
	dataset := testDataset(t, collectionID, "Legacy", legacyScope)
	var metadata datasetMetadata
	_ = json.Unmarshal([]byte(dataset.Description), &metadata)
	metadata.Version = legacyMetadataVersion
	dataset.Description = mustJSON(metadata)
	fake.datasets = []Dataset{dataset}
	fake.documents = []Document{{ID: "internal-doc", Name: "legacy.md", MetaFields: testDocumentMetadata(documentID, "legacy.md", "text/markdown", "", legacyScope, "sha")}}

	migrated, err := provider.MigrateCollectionScope(context.Background(), actor, ports.KnowledgeCollectionRef{ID: collectionID})
	if err != nil || migrated.ReadOnly || fake.updateDocumentCalls != 1 || fake.updateDatasetCalls != 1 {
		t.Fatalf("migrated=%+v document updates=%d dataset updates=%d err=%v", migrated, fake.updateDocumentCalls, fake.updateDatasetCalls, err)
	}
	if metadataString(fake.documents[0].MetaFields, metaScope) != targetScope {
		t.Fatalf("document scope=%q", metadataString(fake.documents[0].MetaFields, metaScope))
	}
	if _, err := provider.MigrateCollectionScope(context.Background(), actor, ports.KnowledgeCollectionRef{ID: collectionID}); err != nil || fake.updateDocumentCalls != 1 {
		t.Fatalf("retry document updates=%d err=%v", fake.updateDocumentCalls, err)
	}
}

func mustJSON(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return string(encoded)
}

func TestListChunksHashesProviderIDsAndMapsPagination(t *testing.T) {
	provider, fake, codec, actor := newTestProvider(t)
	collectionID, _ := codec.CollectionID(actor, "kb")
	documentID, _ := codec.DocumentID(collectionID, "doc")
	scope, _ := codec.ScopeFingerprint(actor)
	fake.datasets = []Dataset{testDataset(t, collectionID, "KB", scope)}
	fake.documents = []Document{{ID: "internal-doc", MetaFields: testDocumentMetadata(documentID, "guide.md", "text/markdown", "", scope, "sha")}}
	fake.chunks = ListChunksResult{Items: []Chunk{{ID: "ragflow-secret-chunk", Content: "text", Positions: []any{[]any{float64(2)}}}}, Total: 3}

	page, err := provider.ListChunks(context.Background(), actor, ports.KnowledgeDocumentRef{ID: documentID, CollectionID: collectionID}, domain.PageRequest{Limit: 1})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Items) != 1 || !strings.HasPrefix(page.Items[0].ID, "chk_") || strings.Contains(page.Items[0].ID, "secret") || page.NextCursor != "2" || !page.HasMore {
		t.Fatalf("page = %+v", page)
	}
}

func TestFailedDocumentUsesSanitizedReason(t *testing.T) {
	scope := "scp_abcdefgh"
	documentID := domain.ID("doc_abcdefgh")
	document, ok := mapDocument(Document{Run: "FAIL", ProgressMsg: json.RawMessage(`"database password secret"`), MetaFields: testDocumentMetadata(documentID, "guide.md", "text/markdown", "", scope, "sha")}, domain.ID("kbs_abcdefgh"), scope)
	if !ok || document.FailureReason != "document parsing failed" || strings.Contains(document.FailureReason, "password") {
		t.Fatalf("document = %+v", document)
	}
}

func newTestProvider(t *testing.T) (*Provider, *fakeRAGFlowClient, *knowledgeid.Codec, domain.ActorContext) {
	t.Helper()
	codec, err := knowledgeid.New([]byte("01234567890123456789012345678901"))
	if err != nil {
		t.Fatal(err)
	}
	fake := &fakeRAGFlowClient{}
	provider, err := NewProvider(fake, codec, "Qwen3-Embedding-0.6B@OpenAI-API-Compatible")
	if err != nil {
		t.Fatal(err)
	}
	actor := domain.ActorContext{TenantID: "tenant", OrgID: "org", UserID: "user", FolderUID: "folder-a"}
	return provider, fake, codec, actor
}

func testDataset(t *testing.T, id domain.ID, displayName, scope string) Dataset {
	t.Helper()
	name, err := knowledgeid.DatasetName(id)
	if err != nil {
		t.Fatal(err)
	}
	description, _ := json.Marshal(datasetMetadata{Version: metadataVersion, DisplayName: displayName, Scope: scope})
	return Dataset{ID: "internal-" + string(id), Name: name, Description: string(description), Status: "1"}
}

func testDocumentMetadata(id domain.ID, name, mediaType, service, scope, digest string) map[string]any {
	return map[string]any{metaPublicID: string(id), metaOriginalName: name, metaMediaType: mediaType, metaService: service, metaTags: []any{"tag"}, metaScope: scope, metaSHA256: digest}
}

func appCode(err error) domain.ErrorCode {
	var appErr *domain.AppError
	if errors.As(err, &appErr) {
		return appErr.Code
	}
	return ""
}

type fakeRAGFlowClient struct {
	datasets            []Dataset
	documents           []Document
	chunks              ListChunksResult
	retrieval           RetrievalResult
	retrievalMetadata   map[string]any
	createCalls         int
	createdName         string
	createdDescription  string
	embeddingModel      string
	uploadCalls         int
	uploadName          string
	uploadedDocument    Document
	updatedMetadata     map[string]any
	updateDocumentCalls int
	updateDocumentErr   error
	updateDatasetCalls  int
	downloadBody        string
}

func (fake *fakeRAGFlowClient) ListDatasets(_ context.Context, _, _ int, name string) (ListDatasetsResult, error) {
	items := make([]Dataset, 0)
	for _, dataset := range fake.datasets {
		if name == "" || dataset.Name == name {
			items = append(items, dataset)
		}
	}
	return ListDatasetsResult{Items: items, Total: len(items)}, nil
}
func (fake *fakeRAGFlowClient) CreateDataset(_ context.Context, name, description, embedding string) (Dataset, error) {
	fake.createCalls++
	fake.createdName, fake.createdDescription, fake.embeddingModel = name, description, embedding
	dataset := Dataset{ID: "new-internal", Name: name, Description: description, Status: "1"}
	fake.datasets = append(fake.datasets, dataset)
	return dataset, nil
}
func (fake *fakeRAGFlowClient) UpdateDataset(_ context.Context, id, description string) error {
	fake.updateDatasetCalls++
	for index := range fake.datasets {
		if fake.datasets[index].ID == id {
			fake.datasets[index].Description = description
		}
	}
	return nil
}
func (*fakeRAGFlowClient) DeleteDataset(context.Context, string) error { return nil }
func (fake *fakeRAGFlowClient) ListDocuments(context.Context, string, int, int, string) (ListDocumentsResult, error) {
	return ListDocumentsResult{Items: fake.documents, Total: len(fake.documents)}, nil
}
func (fake *fakeRAGFlowClient) UploadDocument(_ context.Context, _ string, name, _ string, _ io.Reader) ([]Document, error) {
	fake.uploadCalls++
	fake.uploadName = name
	fake.uploadedDocument = Document{ID: "internal-upload", Name: name, Size: 5, Run: "UNSTART"}
	return []Document{fake.uploadedDocument}, nil
}
func (fake *fakeRAGFlowClient) UpdateDocument(_ context.Context, _, id string, metadata map[string]any) error {
	fake.updateDocumentCalls++
	fake.updatedMetadata = cloneMetadata(metadata)
	fake.uploadedDocument.MetaFields = cloneMetadata(metadata)
	for index := range fake.documents {
		if fake.documents[index].ID == id {
			fake.documents[index].MetaFields = cloneMetadata(metadata)
		}
	}
	return fake.updateDocumentErr
}
func (*fakeRAGFlowClient) DeleteDocument(context.Context, string, string) error { return nil }
func (*fakeRAGFlowClient) StartIndexing(context.Context, string, string) error  { return nil }
func (*fakeRAGFlowClient) StopIndexing(context.Context, string, string) error   { return nil }
func (fake *fakeRAGFlowClient) ListChunks(context.Context, string, string, int, int) (ListChunksResult, error) {
	return fake.chunks, nil
}
func (fake *fakeRAGFlowClient) Retrieve(_ context.Context, _ []string, _ string, _ int, _ float64, metadata map[string]any) (RetrievalResult, error) {
	fake.retrievalMetadata = metadata
	return fake.retrieval, nil
}
func (fake *fakeRAGFlowClient) DownloadDocument(context.Context, string, string) (*http.Response, error) {
	body := fake.downloadBody
	if body == "" {
		body = "body"
	}
	return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(body))}, nil
}

var _ ragflowClient = (*fakeRAGFlowClient)(nil)
