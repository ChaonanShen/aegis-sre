package httpserver

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/1024XEngineer/aegis-sre/internal/adapters/knowledgeid"
	"github.com/1024XEngineer/aegis-sre/internal/domain"
	"github.com/1024XEngineer/aegis-sre/internal/platform/config"
	"github.com/1024XEngineer/aegis-sre/internal/ports"
	"github.com/1024XEngineer/aegis-sre/internal/ports/contracttest"
)

func TestCreateKnowledgeBaseDerivesIDFromTrustedFolder(t *testing.T) {
	server, fake := newKnowledgeHTTPServer(t)
	request := knowledgeRequest(http.MethodPost, "/api/v1/knowledge-bases", `{"name":"Checkout docs","folder_uid":"folder-a"}`)
	request.Header.Set("Idempotency-Key", "create-kb-001")
	response := httptest.NewRecorder()
	server.Handler.ServeHTTP(response, request)

	if response.Code != http.StatusCreated {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if !strings.HasPrefix(string(fake.createInput.ID), "kbs_") || fake.createInput.FolderUID != "folder-a" || fake.createActor.FolderUID != "folder-a" {
		t.Fatalf("input=%+v actor=%+v", fake.createInput, fake.createActor)
	}
	if strings.Contains(response.Body.String(), "internal") || strings.Contains(response.Body.String(), "dataset") {
		t.Fatalf("response leaks provider identifiers: %s", response.Body.String())
	}
}

func TestKnowledgeWritesRequireTrustedFolderAndEditorRole(t *testing.T) {
	server, fake := newKnowledgeHTTPServer(t)
	tests := []struct {
		name   string
		mutate func(*http.Request)
	}{
		{name: "missing folder", mutate: func(request *http.Request) { request.Header.Del("X-Aegis-Folder-UID") }},
		{name: "viewer", mutate: func(request *http.Request) { request.Header.Set("X-Aegis-Roles", "Viewer") }},
		{name: "mismatched body folder", mutate: func(request *http.Request) {
			request.Body = io.NopCloser(strings.NewReader(`{"name":"KB","folder_uid":"folder-b"}`))
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := knowledgeRequest(http.MethodPost, "/api/v1/knowledge-bases", `{"name":"KB","folder_uid":"folder-a"}`)
			request.Header.Set("Idempotency-Key", "create-kb-001")
			test.mutate(request)
			response := httptest.NewRecorder()
			server.Handler.ServeHTTP(response, request)
			if response.Code != http.StatusForbidden {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
	if fake.createCalls != 0 {
		t.Fatalf("provider create calls = %d", fake.createCalls)
	}
}

func TestMultipartUploadComputesDigestAndNormalizesMediaType(t *testing.T) {
	server, fake := newKnowledgeHTTPServer(t)
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, _ := writer.CreateFormFile("file", "故障手册.PDF")
	_, _ = io.WriteString(part, "pdf bytes")
	_ = writer.WriteField("service", "checkout")
	_ = writer.WriteField("tags", "sev1")
	_ = writer.WriteField("tags", "payment")
	_ = writer.Close()
	request := knowledgeRequest(http.MethodPost, "/api/v1/knowledge-bases/kbs_abcdefgh/documents", "")
	request.Body = io.NopCloser(body)
	request.ContentLength = int64(body.Len())
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request.Header.Set("Idempotency-Key", "upload-doc-001")
	response := httptest.NewRecorder()
	server.Handler.ServeHTTP(response, request)

	if response.Code != http.StatusAccepted {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	wantHash := sha256.Sum256([]byte("pdf bytes"))
	if fake.uploadFile.Name != "故障手册.PDF" || fake.uploadFile.MediaType != "application/pdf" || fake.uploadFile.SHA256 != hex.EncodeToString(wantHash[:]) || fake.uploadFile.Service != "checkout" || len(fake.uploadFile.Tags) != 2 || fake.uploadContent != "pdf bytes" {
		t.Fatalf("file=%+v content=%q", fake.uploadFile, fake.uploadContent)
	}
	if !strings.HasPrefix(string(fake.uploadFile.ID), "doc_") {
		t.Fatalf("document ID = %q", fake.uploadFile.ID)
	}
}

func TestUploadRejectsUnsupportedFilesBeforeProvider(t *testing.T) {
	server, fake := newKnowledgeHTTPServer(t)
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, _ := writer.CreateFormFile("file", "payload.exe")
	_, _ = io.WriteString(part, "binary")
	_ = writer.Close()
	request := knowledgeRequest(http.MethodPost, "/api/v1/knowledge-bases/kbs_abcdefgh/documents", "")
	request.Body = io.NopCloser(body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request.Header.Set("Idempotency-Key", "upload-doc-001")
	response := httptest.NewRecorder()
	server.Handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || fake.uploadCalls != 0 {
		t.Fatalf("status=%d calls=%d body=%s", response.Code, fake.uploadCalls, response.Body.String())
	}
}

func TestKnowledgeSearchReturnsStableCitations(t *testing.T) {
	server, fake := newKnowledgeHTTPServer(t)
	fake.hits = []ports.RetrievalHit{{Document: ports.KnowledgeDocumentRef{ID: "doc_abcdefgh", CollectionID: "kbs_abcdefgh"}, SourceName: "guide.md", Text: "restart worker", Score: .94, Position: "section 2", PageNumber: 3}}
	request := knowledgeRequest(http.MethodPost, "/api/v1/knowledge:search", `{"query":"restart","knowledge_base_ids":["kbs_abcdefgh"],"service":"checkout"}`)
	request.Header.Set("X-Aegis-Roles", "Viewer")
	response := httptest.NewRecorder()
	server.Handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if fake.retrieveInput.Limit != 5 || fake.retrieveInput.Threshold != .2 || fake.retrieveActor.FolderUID != "folder-a" || !strings.Contains(response.Body.String(), `"source_name":"guide.md"`) || strings.Contains(response.Body.String(), "internal-doc") {
		t.Fatalf("input=%+v actor=%+v body=%s", fake.retrieveInput, fake.retrieveActor, response.Body.String())
	}
}

func TestKnowledgeProviderErrorsAreSanitized(t *testing.T) {
	server, fake := newKnowledgeHTTPServer(t)
	fake.listErr = &domain.AppError{Code: domain.ErrorProviderUnavailable, Message: "safe", Cause: errors.New("secret RAGFlow response")}
	request := knowledgeRequest(http.MethodGet, "/api/v1/knowledge-bases", "")
	response := httptest.NewRecorder()
	server.Handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadGateway || strings.Contains(response.Body.String(), "secret") || strings.Contains(response.Body.String(), "RAGFlow") {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestDocumentIndexActionUsesPublicReference(t *testing.T) {
	server, fake := newKnowledgeHTTPServer(t)
	request := knowledgeRequest(http.MethodPost, "/api/v1/knowledge-bases/kbs_abcdefgh/documents/doc_abcdefgh:index", "")
	response := httptest.NewRecorder()
	server.Handler.ServeHTTP(response, request)
	if response.Code != http.StatusAccepted || fake.startRef.ID != "doc_abcdefgh" || fake.startRef.CollectionID != "kbs_abcdefgh" {
		t.Fatalf("status=%d ref=%+v body=%s", response.Code, fake.startRef, response.Body.String())
	}
}

func newKnowledgeHTTPServer(t *testing.T) (*http.Server, *knowledgeHTTPFake) {
	t.Helper()
	ids, err := knowledgeid.New([]byte("01234567890123456789012345678901"))
	if err != nil {
		t.Fatal(err)
	}
	fake := &knowledgeHTTPFake{}
	server := New(config.Config{Endpoints: map[config.Capability]string{}}, nil, WithKnowledgeProvider(fake, ids))
	return server, fake
}

func knowledgeRequest(method, path, body string) *http.Request {
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set(headerTenantID, "tenant")
	request.Header.Set(headerOrgID, "org")
	request.Header.Set(headerUserID, "user")
	request.Header.Set("X-Aegis-Folder-UID", "folder-a")
	request.Header.Set("X-Aegis-Roles", "Editor")
	return request
}

type knowledgeHTTPFake struct {
	contracttest.KnowledgeProvider
	createActor   domain.ActorContext
	createInput   ports.CreateKnowledgeCollectionInput
	createCalls   int
	uploadFile    ports.DocumentFile
	uploadContent string
	uploadCalls   int
	hits          []ports.RetrievalHit
	retrieveActor domain.ActorContext
	retrieveInput ports.RetrievalInput
	listErr       error
	startRef      ports.KnowledgeDocumentRef
}

func (fake *knowledgeHTTPFake) ListCollections(context.Context, domain.ActorContext, string, domain.PageRequest) (domain.Page[ports.KnowledgeCollection], error) {
	return domain.Page[ports.KnowledgeCollection]{Items: []ports.KnowledgeCollection{}}, fake.listErr
}
func (fake *knowledgeHTTPFake) CreateCollection(_ context.Context, actor domain.ActorContext, input ports.CreateKnowledgeCollectionInput) (ports.KnowledgeCollection, error) {
	fake.createCalls++
	fake.createActor, fake.createInput = actor, input
	return ports.KnowledgeCollection{Ref: ports.KnowledgeCollectionRef{ID: input.ID}, Name: input.Name, FolderUID: input.FolderUID, Status: domain.KnowledgeBaseActive}, nil
}
func (fake *knowledgeHTTPFake) UploadDocument(_ context.Context, _ domain.ActorContext, collection ports.KnowledgeCollectionRef, file ports.DocumentFile) (ports.KnowledgeDocument, error) {
	fake.uploadCalls++
	fake.uploadFile = file
	content, _ := io.ReadAll(file.Content)
	fake.uploadContent = string(content)
	return ports.KnowledgeDocument{Ref: ports.KnowledgeDocumentRef{ID: file.ID, CollectionID: collection.ID}, Name: file.Name, MediaType: file.MediaType, Service: file.Service, Tags: file.Tags, Status: domain.DocumentPending, Size: file.Size}, nil
}
func (fake *knowledgeHTTPFake) Retrieve(_ context.Context, actor domain.ActorContext, input ports.RetrievalInput) ([]ports.RetrievalHit, error) {
	fake.retrieveActor, fake.retrieveInput = actor, input
	return fake.hits, nil
}
func (fake *knowledgeHTTPFake) StartIndexing(_ context.Context, _ domain.ActorContext, ref ports.KnowledgeDocumentRef) error {
	fake.startRef = ref
	return nil
}

var _ ports.KnowledgeProvider = (*knowledgeHTTPFake)(nil)
