package knowledgemcp

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/1024XEngineer/aegis-sre/internal/domain"
	"github.com/1024XEngineer/aegis-sre/internal/mcpcall"
	"github.com/1024XEngineer/aegis-sre/internal/ports"
)

func TestKnowledgeMCPStreamableHTTPToolsUseBoundActorAndStableIDs(t *testing.T) {
	fake := &knowledgeFake{}
	server, tokenPath := testServer(t, fake)

	search := callTool(t, server.URL, tokenPath, "knowledge.search", map[string]any{
		"folder_uid": "ops", "query": "restart api", "knowledge_base_ids": []string{"kbs_abcdefgh"}, "limit": 5,
	})
	hits := search["hits"].([]any)
	citation := hits[0].(map[string]any)["citation"].(map[string]any)
	if citation["document_id"] != "doc_abcdefgh" || fake.lastActor.FolderUID != "ops" || fake.lastActor.UserID != "knowledge-agent" {
		t.Fatalf("search = %#v, actor = %+v", search, fake.lastActor)
	}

	document := callTool(t, server.URL, tokenPath, "knowledge.get_document", map[string]any{
		"folder_uid": "ops", "knowledge_base_id": "kbs_abcdefgh", "document_id": "doc_abcdefgh",
	})
	if document["id"] != "doc_abcdefgh" || len(document["chunks"].([]any)) != 1 {
		t.Fatalf("document = %#v", document)
	}

	sources := callTool(t, server.URL, tokenPath, "knowledge.list_sources", map[string]any{"folder_uid": "ops", "service": "api"})
	items := sources["sources"].([]any)
	if len(items) != 1 || items[0].(map[string]any)["knowledge_base_id"] != "kbs_abcdefgh" {
		t.Fatalf("sources = %#v", sources)
	}
}

func TestKnowledgeMCPRejectsTokenAndFolderEscalation(t *testing.T) {
	fake := &knowledgeFake{}
	server, tokenPath := testServer(t, fake)

	request, _ := http.NewRequest(http.MethodPost, server.URL, nil)
	request.Header.Set("Authorization", "Bearer wrong")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d", response.StatusCode)
	}

	config := mcpcallConfig(server.URL, tokenPath)
	_, err = mcpcall.Call(context.Background(), "knowledge", config, "knowledge.search", map[string]any{"folder_uid": "secret", "query": "data"}, t.TempDir(), mcpcall.RequestMetadata{})
	if err == nil {
		t.Fatalf("error = %v", err)
	}
	if fake.retrieveCalls != 0 {
		t.Fatalf("provider called %d times", fake.retrieveCalls)
	}
}

func TestKnowledgeMCPBoundsChunkAndResultCount(t *testing.T) {
	fake := &knowledgeFake{longResults: true}
	server, tokenPath := testServer(t, fake)
	result := callTool(t, server.URL, tokenPath, "knowledge.search", map[string]any{"folder_uid": "ops", "query": "bounded", "limit": 10})
	hits := result["hits"].([]any)
	if len(hits) == 0 || len(hits) > 10 {
		t.Fatalf("hits = %d", len(hits))
	}
	total := 0
	for _, raw := range hits {
		text := raw.(map[string]any)["text"].(string)
		total += len(text)
		if len(text) > maxChunkBytes {
			t.Fatal("chunk exceeded response bound")
		}
	}
	if total > maxStructuredTextBytes {
		t.Fatalf("text bytes = %d", total)
	}
}

func testServer(t *testing.T, provider ports.KnowledgeProvider) (*httptest.Server, string) {
	t.Helper()
	tokenPath := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(tokenPath, []byte("knowledge-secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	handler, err := NewHandler(provider, Config{TokenFile: tokenPath, TenantID: "tenant", OrgID: "org", UserID: "knowledge-agent", FolderUIDs: []string{"ops", "payments"}})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	return server, tokenPath
}

func callTool(t *testing.T, url, tokenPath, tool string, arguments map[string]any) map[string]any {
	t.Helper()
	output, err := mcpcall.Call(context.Background(), "knowledge", mcpcallConfig(url, tokenPath), tool, arguments, t.TempDir(), mcpcall.RequestMetadata{})
	if err != nil {
		t.Fatal(err)
	}
	result, ok := output.Result.(map[string]any)
	if !ok {
		t.Fatalf("result = %#v", output.Result)
	}
	return result
}

func mcpcallConfig(url, tokenPath string) mcpcall.ServerConfig {
	return mcpcall.ServerConfig{URL: url, BearerTokenFile: tokenPath, ConnectTimeout: time.Second, HandshakeTimeout: time.Second, CallTimeout: time.Second, TotalTimeout: 3 * time.Second, MaxTextBytes: 4096, MaxStructured: 128 << 10, MaxBinaryBytes: 256 << 10}
}

type knowledgeFake struct {
	lastActor     domain.ActorContext
	retrieveCalls int
	longResults   bool
}

func (fake *knowledgeFake) Check(context.Context) error { return nil }
func (fake *knowledgeFake) ListCollections(_ context.Context, actor domain.ActorContext, folder string, _ domain.PageRequest) (domain.Page[ports.KnowledgeCollection], error) {
	fake.lastActor = actor
	if actor.FolderUID != folder {
		return domain.Page[ports.KnowledgeCollection]{}, &domain.AppError{Code: domain.ErrorForbidden}
	}
	return domain.Page[ports.KnowledgeCollection]{Items: []ports.KnowledgeCollection{{Ref: ports.KnowledgeCollectionRef{ID: "kbs_abcdefgh"}, Name: "Operations", FolderUID: folder, Status: domain.KnowledgeBaseActive}}}, nil
}
func (fake *knowledgeFake) GetCollection(_ context.Context, actor domain.ActorContext, ref ports.KnowledgeCollectionRef) (ports.KnowledgeCollection, error) {
	fake.lastActor = actor
	return ports.KnowledgeCollection{Ref: ref, Name: "Operations", FolderUID: actor.FolderUID, Status: domain.KnowledgeBaseActive}, nil
}
func (fake *knowledgeFake) CreateCollection(context.Context, domain.ActorContext, ports.CreateKnowledgeCollectionInput) (ports.KnowledgeCollection, error) {
	panic("unexpected mutation")
}
func (fake *knowledgeFake) UpdateCollection(context.Context, domain.ActorContext, ports.KnowledgeCollectionRef, ports.UpdateKnowledgeCollectionInput) (ports.KnowledgeCollection, error) {
	panic("unexpected mutation")
}
func (fake *knowledgeFake) DeleteCollection(context.Context, domain.ActorContext, ports.KnowledgeCollectionRef) error {
	panic("unexpected mutation")
}
func (fake *knowledgeFake) ListDocuments(_ context.Context, actor domain.ActorContext, ref ports.KnowledgeCollectionRef, _ domain.PageRequest) (domain.Page[ports.KnowledgeDocument], error) {
	fake.lastActor = actor
	return domain.Page[ports.KnowledgeDocument]{Items: []ports.KnowledgeDocument{{Ref: ports.KnowledgeDocumentRef{ID: "doc_abcdefgh", CollectionID: ref.ID}, Name: "restart.md", MediaType: "text/markdown", Service: "api", Tags: []string{"prod"}, Status: domain.DocumentReady}}}, nil
}
func (fake *knowledgeFake) GetDocument(_ context.Context, actor domain.ActorContext, ref ports.KnowledgeDocumentRef) (ports.KnowledgeDocument, error) {
	fake.lastActor = actor
	return ports.KnowledgeDocument{Ref: ref, Name: "restart.md", MediaType: "text/markdown", Service: "api", Tags: []string{"prod"}, Status: domain.DocumentReady}, nil
}
func (fake *knowledgeFake) UploadDocument(context.Context, domain.ActorContext, ports.KnowledgeCollectionRef, ports.DocumentFile) (ports.KnowledgeDocument, error) {
	panic("unexpected mutation")
}
func (fake *knowledgeFake) UpdateDocument(context.Context, domain.ActorContext, ports.KnowledgeDocumentRef, ports.UpdateKnowledgeDocumentInput) (ports.KnowledgeDocument, error) {
	panic("unexpected mutation")
}
func (fake *knowledgeFake) StartIndexing(context.Context, domain.ActorContext, ports.KnowledgeDocumentRef) error {
	panic("unexpected mutation")
}
func (fake *knowledgeFake) StopIndexing(context.Context, domain.ActorContext, ports.KnowledgeDocumentRef) error {
	panic("unexpected mutation")
}
func (fake *knowledgeFake) DeleteDocument(context.Context, domain.ActorContext, ports.KnowledgeDocumentRef) error {
	panic("unexpected mutation")
}
func (fake *knowledgeFake) ListChunks(_ context.Context, actor domain.ActorContext, ref ports.KnowledgeDocumentRef, _ domain.PageRequest) (domain.Page[ports.KnowledgeChunk], error) {
	fake.lastActor = actor
	return domain.Page[ports.KnowledgeChunk]{Items: []ports.KnowledgeChunk{{ID: "chk_abcdefgh", Document: ref, Text: "restart one instance", Position: "paragraph-4", PageNumber: 2}}}, nil
}
func (fake *knowledgeFake) DownloadDocument(context.Context, domain.ActorContext, ports.KnowledgeDocumentRef) (ports.KnowledgeDocumentDownload, error) {
	return ports.KnowledgeDocumentDownload{Content: io.NopCloser(strings.NewReader(""))}, nil
}
func (fake *knowledgeFake) Retrieve(_ context.Context, actor domain.ActorContext, input ports.RetrievalInput) ([]ports.RetrievalHit, error) {
	fake.lastActor, fake.retrieveCalls = actor, fake.retrieveCalls+1
	count := 1
	text := "restart one instance"
	if fake.longResults {
		count, text = 20, strings.Repeat("界", maxChunkBytes)
	}
	result := make([]ports.RetrievalHit, 0, count)
	for range count {
		result = append(result, ports.RetrievalHit{Document: ports.KnowledgeDocumentRef{ID: "doc_abcdefgh", CollectionID: input.Collections[0].ID}, SourceName: "restart.md", Text: text, Score: .9, Position: "paragraph-4", PageNumber: 2})
	}
	return result, nil
}
