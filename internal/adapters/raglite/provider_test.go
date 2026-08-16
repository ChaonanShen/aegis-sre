package raglite

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/1024XEngineer/aegis-sre/internal/adapters/knowledgeid"
	"github.com/1024XEngineer/aegis-sre/internal/domain"
	"github.com/1024XEngineer/aegis-sre/internal/ports"
)

func testProvider(t *testing.T) (*Provider, *fakeClient, *knowledgeid.Codec, domain.ActorContext) {
	t.Helper()
	codec, err := knowledgeid.New([]byte("01234567890123456789012345678901"))
	if err != nil {
		t.Fatal(err)
	}
	actor := domain.ActorContext{TenantID: "tenant", OrgID: "org", UserID: "user", FolderUID: "folder-a"}
	scope, _ := codec.ScopeFingerprint(actor)
	legacyScope, _ := codec.LegacyScopeFingerprint(actor)
	fake := &fakeClient{scope: scope, legacyScope: legacyScope}
	provider, err := NewProvider(fake, codec)
	if err != nil {
		t.Fatal(err)
	}
	return provider, fake, codec, actor
}

func TestProviderCollectionAndDocumentRoundTrip(t *testing.T) {
	provider, fake, _, actor := testProvider(t)
	collection, err := provider.CreateCollection(context.Background(), actor, ports.CreateKnowledgeCollectionInput{
		ID: "kbs_abcdefgh", Name: "Operations", FolderUID: "folder-a",
	})
	if err != nil || collection.Name != "Operations" || fake.lastScope == "" {
		t.Fatalf("create collection failed: %+v %v", collection, err)
	}
	payload := "hello"
	sum := sha256.Sum256([]byte(payload))
	document, err := provider.UploadDocument(context.Background(), actor, collection.Ref, ports.DocumentFile{
		ID: "doc_abcdefgh", Name: "runbook.md", MediaType: "text/markdown", Service: "checkout",
		Tags: []string{"prod"}, Size: int64(len(payload)), SHA256: hex.EncodeToString(sum[:]), Content: strings.NewReader(payload),
	})
	if err != nil || document.Ref.CollectionID != collection.Ref.ID || document.Status != domain.DocumentQueued {
		t.Fatalf("upload failed: %+v %v", document, err)
	}
	page, err := provider.ListDocuments(context.Background(), actor, collection.Ref, domain.PageRequest{Limit: 1})
	if err != nil || len(page.Items) != 1 {
		t.Fatalf("list failed: %+v %v", page, err)
	}
}

func TestProviderDerivesChunkIDsAndMapsSearch(t *testing.T) {
	provider, fake, _, actor := testProvider(t)
	fake.chunks = []Chunk{{ID: "internal-chunk", DocumentID: "doc_abcdefgh", CollectionID: "kbs_abcdefgh", SourceName: "runbook.md", Text: "restart", Position: "0"}}
	ref := ports.KnowledgeDocumentRef{ID: "doc_abcdefgh", CollectionID: "kbs_abcdefgh"}
	page, err := provider.ListChunks(context.Background(), actor, ref, domain.PageRequest{Limit: 20})
	if err != nil || len(page.Items) != 1 || !strings.HasPrefix(page.Items[0].ID, "chk_") || strings.Contains(page.Items[0].ID, "internal") {
		t.Fatalf("chunk mapping failed: %+v %v", page, err)
	}
	fake.hits = []SearchHit{{Chunk: fake.chunks[0], Score: 0.5}}
	hits, err := provider.Retrieve(context.Background(), actor, ports.RetrievalInput{
		Query: "restart", Collections: []ports.KnowledgeCollectionRef{{ID: "kbs_abcdefgh"}}, Limit: 5,
	})
	if err != nil || len(hits) != 1 || hits[0].Document.ID != "doc_abcdefgh" || hits[0].Document.CollectionID != "kbs_abcdefgh" || hits[0].PageNumber != 0 {
		t.Fatalf("search mapping failed: %+v %v", hits, err)
	}
}

func TestProductProviderMapsPassagesSearchAndRetryWithoutPrivateIDs(t *testing.T) {
	provider, fake, _, actor := testProvider(t)
	fake.chunks = []Chunk{{ID: "private-chunk", DocumentID: "doc_abcdefgh", CollectionID: "kbs_abcdefgh", SourceName: "runbook.md", Text: "restart", Position: "0"}}
	fake.hits = []SearchHit{{Chunk: fake.chunks[0], Score: .75}}
	ref := ports.KnowledgeDocumentRef{ID: "doc_abcdefgh", CollectionID: "kbs_abcdefgh"}

	passages, err := provider.ListDocumentPassages(context.Background(), actor, ref, domain.PageRequest{Limit: 20})
	if err != nil || len(passages.Items) != 1 || passages.Items[0].Ordinal != 1 || passages.Items[0].Location != "0" {
		t.Fatalf("passages=%+v err=%v", passages, err)
	}
	citations, err := provider.Search(context.Background(), actor, ports.KnowledgeSearchInput{
		Query: "restart", KnowledgeBases: []ports.KnowledgeBaseRef{{ID: "kbs_abcdefgh"}},
		Service: "checkout", TagsAll: []string{"prod"}, Limit: 5,
	})
	if err != nil || len(citations) != 1 || citations[0].Ordinal != 1 || citations[0].Document.ID != ref.ID {
		t.Fatalf("citations=%+v err=%v", citations, err)
	}
	document, err := provider.RetryDocumentIndex(context.Background(), actor, ref)
	if err != nil || document.Ref != ref || fake.mutations != 1 {
		t.Fatalf("document=%+v mutations=%d err=%v", document, fake.mutations, err)
	}
}

func TestProviderRejectsSearchHitOutsideRequestedCollections(t *testing.T) {
	provider, fake, _, actor := testProvider(t)
	fake.hits = []SearchHit{{Chunk: Chunk{
		ID: "internal-chunk", DocumentID: "doc_abcdefgh", CollectionID: "kbs_other0000",
		SourceName: "runbook.md", Text: "restart", Position: "0",
	}, Score: 0.5}}

	_, err := provider.Retrieve(context.Background(), actor, ports.RetrievalInput{
		Query: "restart", Collections: []ports.KnowledgeCollectionRef{{ID: "kbs_abcdefgh"}}, Limit: 5,
	})
	assertCode(t, err, domain.ErrorProviderResultUnknown)
}

func TestProviderRejectsDigestMismatchAndScopeMismatch(t *testing.T) {
	provider, fake, _, actor := testProvider(t)
	fake.badDigest = true
	_, err := provider.UploadDocument(context.Background(), actor, ports.KnowledgeCollectionRef{ID: "kbs_abcdefgh"}, ports.DocumentFile{
		ID: "doc_abcdefgh", Name: "runbook.md", MediaType: "text/markdown", Size: 5,
		SHA256: strings.Repeat("a", 64), Content: strings.NewReader("hello"),
	})
	assertCode(t, err, domain.ErrorProviderResultUnknown)

	fake.collections = []Collection{fake.collection()}
	fake.collections[0].Scope = "scp_other000"
	_, err = provider.ListCollections(context.Background(), actor, "folder-a", domain.PageRequest{Limit: 20})
	assertCode(t, err, domain.ErrorProviderResultUnknown)
}

func TestProviderRejectsReturnedFolderMismatchBeforeChildMutation(t *testing.T) {
	provider, fake, _, actor := testProvider(t)
	foreign := fake.collection()
	foreign.FolderUID = "folder-b"
	fake.getCollection = &foreign

	_, err := provider.GetCollection(context.Background(), actor, ports.KnowledgeCollectionRef{ID: "kbs_abcdefgh"})
	assertCode(t, err, domain.ErrorProviderResultUnknown)
	err = provider.DeleteDocument(context.Background(), actor, ports.KnowledgeDocumentRef{ID: "doc_abcdefgh", CollectionID: "kbs_abcdefgh"})
	assertCode(t, err, domain.ErrorProviderResultUnknown)
	if fake.mutations != 0 {
		t.Fatalf("child mutation reached Provider before parent Folder validation: %d", fake.mutations)
	}
}

func TestProviderReadsLegacyUserScopeButRejectsWritesAndOtherUsers(t *testing.T) {
	provider, fake, codec, actor := testProvider(t)
	legacy := fake.collection()
	legacy.ID = "kbs_legacy12345"
	legacy.Name = "Legacy"
	legacy.Scope = fake.legacyScope
	fake.legacyCollection = &legacy
	legacyDocument := fake.document()
	legacyDocument.CollectionID = legacy.ID
	fake.documents = []Document{legacyDocument}
	ref := ports.KnowledgeCollectionRef{ID: domain.ID(legacy.ID)}

	collection, err := provider.GetCollection(context.Background(), actor, ref)
	if err != nil || collection.Name != "Legacy" {
		t.Fatalf("legacy collection = %#v, err = %v", collection, err)
	}
	if _, err := provider.ListDocuments(context.Background(), actor, ref, domain.PageRequest{}); err != nil {
		t.Fatalf("legacy document list failed: %v", err)
	}
	if _, err := provider.UpdateCollection(context.Background(), actor, ref, ports.UpdateKnowledgeCollectionInput{Name: "changed", Status: domain.KnowledgeBaseActive}); appErrorCode(err) != domain.ErrorNotFound {
		t.Fatalf("legacy update error = %#v", err)
	}
	other := actor
	other.UserID = "other-user"
	otherLegacyScope, _ := codec.LegacyScopeFingerprint(other)
	if otherLegacyScope == fake.legacyScope {
		t.Fatal("legacy test scope must remain user-bound")
	}
	if _, err := provider.GetCollection(context.Background(), other, ref); appErrorCode(err) != domain.ErrorNotFound {
		t.Fatalf("legacy resource escaped creator: %#v", err)
	}
	if fake.mutations != 0 {
		t.Fatalf("legacy write reached Provider: %d", fake.mutations)
	}
}

func TestProviderMigratesLegacyScopeAndMakesRetriesIdempotent(t *testing.T) {
	provider, fake, _, actor := testProvider(t)
	legacy := fake.collection()
	legacy.ID = "kbs_legacy12345"
	legacy.Scope = fake.legacyScope
	fake.legacyCollection = &legacy
	ref := ports.KnowledgeCollectionRef{ID: domain.ID(legacy.ID)}

	migrated, err := provider.MigrateCollectionScope(context.Background(), actor, ref)
	if err != nil || migrated.ReadOnly || migrated.FolderUID != actor.FolderUID || fake.mutations != 1 {
		t.Fatalf("migrated=%+v mutations=%d err=%v", migrated, fake.mutations, err)
	}
	current := fake.collection()
	current.ID = string(migrated.Ref.ID)
	current.Name = migrated.Name
	fake.getCollection = &current
	if _, err := provider.MigrateCollectionScope(context.Background(), actor, ref); err != nil || fake.mutations != 1 {
		t.Fatalf("idempotent retry mutations=%d err=%v", fake.mutations, err)
	}
}

func appErrorCode(err error) domain.ErrorCode {
	var appErr *domain.AppError
	if errors.As(err, &appErr) {
		return appErr.Code
	}
	return ""
}

func TestProviderMapsCapabilityAndNotFoundErrors(t *testing.T) {
	provider, fake, _, actor := testProvider(t)
	fake.err = &ProviderError{Code: "capability_unavailable", StatusCode: 422}
	err := provider.StopIndexing(context.Background(), actor, ports.KnowledgeDocumentRef{ID: "doc_abcdefgh", CollectionID: "kbs_abcdefgh"})
	assertCode(t, err, domain.ErrorCapabilityUnavailable)
	fake.err = &ProviderError{Code: "not_found", StatusCode: 404}
	_, err = provider.GetCollection(context.Background(), actor, ports.KnowledgeCollectionRef{ID: "kbs_abcdefgh"})
	assertCode(t, err, domain.ErrorNotFound)
}

func TestProviderRejectsCrossFolderBeforeCallingProvider(t *testing.T) {
	provider, fake, _, actor := testProvider(t)
	_, err := provider.ListCollections(context.Background(), actor, "folder-b", domain.PageRequest{})
	assertCode(t, err, domain.ErrorForbidden)
	if fake.lastScope != "" {
		t.Fatal("provider must not be called for cross-folder request")
	}
}

func TestOwnershipInventoryClassifiesCurrentLegacyAndOrphanCollections(t *testing.T) {
	provider, fake, _, actor := testProvider(t)
	legacy := fake.collection()
	legacy.ID, legacy.Scope = "kbs_legacy12345", fake.legacyScope
	fake.legacyCollection = &legacy
	items, err := provider.InventoryOwnership(context.Background(), actor, []string{actor.FolderUID})
	if err != nil || len(items) != 2 || items[0].State != ports.OwnershipActive || items[1].State != ports.OwnershipLegacy {
		t.Fatalf("items=%+v err=%v", items, err)
	}
	fake.legacyCollection.FolderUID = "deleted-folder"
	items, err = provider.InventoryOwnership(context.Background(), actor, []string{actor.FolderUID})
	if err != nil || items[1].State != ports.OwnershipOrphan {
		t.Fatalf("orphan items=%+v err=%v", items, err)
	}
}

func assertCode(t *testing.T, err error, code domain.ErrorCode) {
	t.Helper()
	var appErr *domain.AppError
	if !errors.As(err, &appErr) || appErr.Code != code {
		t.Fatalf("expected %s, got %#v", code, err)
	}
}

type fakeClient struct {
	scope            string
	legacyScope      string
	lastScope        string
	collections      []Collection
	documents        []Document
	chunks           []Chunk
	hits             []SearchHit
	err              error
	badDigest        bool
	getCollection    *Collection
	legacyCollection *Collection
	mutations        int
}

func (f *fakeClient) collection() Collection {
	return Collection{ID: "kbs_abcdefgh", Name: "Operations", FolderUID: "folder-a", Scope: f.scope, Status: "active", CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano)}
}
func (f *fakeClient) document() Document {
	sum := sha256.Sum256([]byte("hello"))
	digest := hex.EncodeToString(sum[:])
	if f.badDigest {
		digest = strings.Repeat("b", 64)
	}
	return Document{ID: "doc_abcdefgh", CollectionID: "kbs_abcdefgh", Name: "runbook.md", MediaType: "text/markdown", Size: 5, SHA256: digest, Service: "checkout", Tags: []string{"prod"}, Status: "queued", CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano)}
}
func (f *fakeClient) Check(context.Context) error { return f.err }
func (f *fakeClient) ListCollections(_ context.Context, scope, _ string) ([]Collection, error) {
	f.lastScope = scope
	if f.err != nil {
		return nil, f.err
	}
	if f.collections != nil {
		return f.collections, nil
	}
	if scope == f.legacyScope {
		if f.legacyCollection == nil {
			return []Collection{}, nil
		}
		return []Collection{*f.legacyCollection}, nil
	}
	return []Collection{f.collection()}, nil
}
func (f *fakeClient) InventoryCollections(context.Context, string) ([]Collection, error) {
	if f.legacyCollection != nil {
		return []Collection{f.collection(), *f.legacyCollection}, f.err
	}
	return []Collection{f.collection()}, f.err
}
func (f *fakeClient) GetCollection(_ context.Context, scope, id string) (Collection, error) {
	f.lastScope = scope
	if f.err != nil {
		return Collection{}, f.err
	}
	if f.getCollection != nil {
		return *f.getCollection, nil
	}
	if scope == f.scope && id == f.collection().ID {
		return f.collection(), nil
	}
	if scope == f.legacyScope && f.legacyCollection != nil && id == f.legacyCollection.ID {
		return *f.legacyCollection, nil
	}
	return Collection{}, &ProviderError{Code: "not_found", StatusCode: http.StatusNotFound}
}
func (f *fakeClient) CreateCollection(_ context.Context, scope string, in Collection) (Collection, error) {
	f.mutations++
	f.lastScope = scope
	if f.err != nil {
		return Collection{}, f.err
	}
	value := f.collection()
	value.ID = in.ID
	value.Name = in.Name
	value.FolderUID = in.FolderUID
	f.collections = []Collection{value}
	return value, nil
}
func (f *fakeClient) UpdateCollection(_ context.Context, scope, _, name, status string) (Collection, error) {
	f.mutations++
	value := f.collection()
	value.Name = name
	value.Status = status
	f.lastScope = scope
	return value, f.err
}
func (f *fakeClient) MigrateCollectionScope(_ context.Context, sourceScope, _ string, targetScope string) (Collection, error) {
	f.mutations++
	f.lastScope = sourceScope
	value := f.collection()
	value.Scope = targetScope
	f.legacyCollection = nil
	return value, f.err
}
func (f *fakeClient) DeleteCollection(_ context.Context, scope, _ string) error {
	f.mutations++
	f.lastScope = scope
	return f.err
}
func (f *fakeClient) ListDocuments(_ context.Context, scope, _ string) ([]Document, error) {
	f.lastScope = scope
	if f.documents != nil {
		return f.documents, f.err
	}
	return []Document{f.document()}, f.err
}
func (f *fakeClient) GetDocument(_ context.Context, scope, _ string) (Document, error) {
	f.lastScope = scope
	return f.document(), f.err
}
func (f *fakeClient) UploadDocument(_ context.Context, scope, _, _, _, _, _ string, _ []string, content io.Reader) (Document, error) {
	f.mutations++
	f.lastScope = scope
	_, _ = io.Copy(io.Discard, content)
	return f.document(), f.err
}
func (f *fakeClient) UpdateDocument(_ context.Context, scope, _, _ string, _ []string) (Document, error) {
	f.mutations++
	f.lastScope = scope
	return f.document(), f.err
}
func (f *fakeClient) DeleteDocument(_ context.Context, scope, _ string) error {
	f.mutations++
	f.lastScope = scope
	return f.err
}
func (f *fakeClient) StartIndexing(_ context.Context, scope, _ string) (Job, error) {
	f.mutations++
	f.lastScope = scope
	return Job{ID: "job_abcdefgh"}, f.err
}
func (f *fakeClient) StopIndexing(_ context.Context, scope, _ string) error {
	f.mutations++
	f.lastScope = scope
	return f.err
}
func (f *fakeClient) RetryIndexing(_ context.Context, scope, _ string) (Document, error) {
	f.mutations++
	f.lastScope = scope
	return f.document(), f.err
}
func (f *fakeClient) ListChunks(_ context.Context, scope, _ string) ([]Chunk, error) {
	f.lastScope = scope
	return f.chunks, f.err
}
func (f *fakeClient) ListPassages(_ context.Context, scope, _ string) ([]Passage, error) {
	f.lastScope = scope
	items := make([]Passage, 0, len(f.chunks))
	for index, chunk := range f.chunks {
		items = append(items, Passage{Ordinal: index + 1, Text: chunk.Text, Location: chunk.Position})
	}
	return items, f.err
}
func (f *fakeClient) Search(_ context.Context, scope, _ string, _ []string, _ string, _ int, _ float64) ([]SearchHit, error) {
	f.lastScope = scope
	return f.hits, f.err
}
func (f *fakeClient) SearchProduct(_ context.Context, scope, _ string, _ []string, _ string, _, _ []string, _ int) ([]SearchHit, error) {
	f.lastScope = scope
	return f.hits, f.err
}
func (f *fakeClient) DownloadDocument(_ context.Context, scope, _ string) (*http.Response, error) {
	f.lastScope = scope
	return &http.Response{Body: io.NopCloser(strings.NewReader("hello"))}, f.err
}

var _ ragliteClient = (*fakeClient)(nil)
