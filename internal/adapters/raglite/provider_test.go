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
	fake := &fakeClient{scope: scope}
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
	if err != nil || document.Ref.CollectionID != collection.Ref.ID || document.Status != domain.DocumentPending {
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

func assertCode(t *testing.T, err error, code domain.ErrorCode) {
	t.Helper()
	var appErr *domain.AppError
	if !errors.As(err, &appErr) || appErr.Code != code {
		t.Fatalf("expected %s, got %#v", code, err)
	}
}

type fakeClient struct {
	scope       string
	lastScope   string
	collections []Collection
	documents   []Document
	chunks      []Chunk
	hits        []SearchHit
	err         error
	badDigest   bool
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
	return Document{ID: "doc_abcdefgh", CollectionID: "kbs_abcdefgh", Name: "runbook.md", MediaType: "text/markdown", Size: 5, SHA256: digest, Service: "checkout", Tags: []string{"prod"}, Status: "pending", CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), UpdatedAt: time.Now().UTC().Format(time.RFC3339Nano)}
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
	return []Collection{f.collection()}, nil
}
func (f *fakeClient) GetCollection(_ context.Context, scope, _ string) (Collection, error) {
	f.lastScope = scope
	if f.err != nil {
		return Collection{}, f.err
	}
	return f.collection(), nil
}
func (f *fakeClient) CreateCollection(_ context.Context, scope string, in Collection) (Collection, error) {
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
	value := f.collection()
	value.Name = name
	value.Status = status
	f.lastScope = scope
	return value, f.err
}
func (f *fakeClient) DeleteCollection(_ context.Context, scope, _ string) error {
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
	f.lastScope = scope
	_, _ = io.Copy(io.Discard, content)
	return f.document(), f.err
}
func (f *fakeClient) UpdateDocument(_ context.Context, scope, _, _ string, _ []string) (Document, error) {
	f.lastScope = scope
	return f.document(), f.err
}
func (f *fakeClient) DeleteDocument(_ context.Context, scope, _ string) error {
	f.lastScope = scope
	return f.err
}
func (f *fakeClient) StartIndexing(_ context.Context, scope, _ string) (Job, error) {
	f.lastScope = scope
	return Job{ID: "job_abcdefgh"}, f.err
}
func (f *fakeClient) StopIndexing(_ context.Context, scope, _ string) error {
	f.lastScope = scope
	return f.err
}
func (f *fakeClient) ListChunks(_ context.Context, scope, _ string) ([]Chunk, error) {
	f.lastScope = scope
	return f.chunks, f.err
}
func (f *fakeClient) Search(_ context.Context, scope, _ string, _ []string, _ string, _ int, _ float64) ([]SearchHit, error) {
	f.lastScope = scope
	return f.hits, f.err
}
func (f *fakeClient) DownloadDocument(_ context.Context, scope, _ string) (*http.Response, error) {
	f.lastScope = scope
	return &http.Response{Body: io.NopCloser(strings.NewReader("hello"))}, f.err
}

var _ ragliteClient = (*fakeClient)(nil)
