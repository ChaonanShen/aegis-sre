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
		{name: "read-only Folder", mutate: func(request *http.Request) { request.Header.Set("X-Aegis-Folder-Access", "read") }},
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
	_, _ = io.WriteString(part, "%PDF-1.7 pdf bytes")
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
	wantHash := sha256.Sum256([]byte("%PDF-1.7 pdf bytes"))
	if fake.uploadFile.Name != "故障手册.PDF" || fake.uploadFile.MediaType != "application/pdf" || fake.uploadFile.SHA256 != hex.EncodeToString(wantHash[:]) || fake.uploadFile.Service != "checkout" || len(fake.uploadFile.Tags) != 2 || fake.uploadContent != "%PDF-1.7 pdf bytes" {
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

func TestUploadRejectsContentThatDoesNotMatchExtension(t *testing.T) {
	server, fake := newKnowledgeHTTPServer(t)
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	part, _ := writer.CreateFormFile("file", "guide.pdf")
	_, _ = io.WriteString(part, "not a pdf")
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
	fake.hits = []ports.KnowledgeCitation{{Document: ports.KnowledgeDocumentRef{ID: "doc_abcdefgh", CollectionID: "kbs_abcdefgh"}, SourceName: "guide.md", Text: "restart worker", Ordinal: 3, Location: "section 2"}}
	request := knowledgeRequest(http.MethodPost, "/api/v1/knowledge:search", `{"query":"restart","knowledge_base_ids":["kbs_abcdefgh"],"service":"checkout","tags_all":["prod"]}`)
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
	if fake.searchInput.Limit != 5 || len(fake.searchInput.TagsAll) != 1 || fake.retrieveActor.FolderUID != "folder-a" || !strings.Contains(response.Body.String(), `"source_name":"guide.md"`) || strings.Contains(response.Body.String(), `"score"`) {
		t.Fatalf("input=%+v actor=%+v body=%s", fake.searchInput, fake.retrieveActor, response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control = %q", response.Header().Get("Cache-Control"))
	}
}

func TestDocumentPassagesAreNotCached(t *testing.T) {
	server, _ := newKnowledgeHTTPServer(t)
	request := knowledgeRequest(http.MethodGet, "/api/v1/knowledge-bases/kbs_abcdefgh/documents/doc_abcdefgh/passages", "")
	response := httptest.NewRecorder()
	server.Handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("Cache-Control = %q", response.Header().Get("Cache-Control"))
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

func TestDocumentRetryActionUsesPublicReference(t *testing.T) {
	server, fake := newKnowledgeHTTPServer(t)
	request := knowledgeRequest(http.MethodPost, "/api/v1/knowledge-bases/kbs_abcdefgh/documents/doc_abcdefgh:retry-index", "")
	response := httptest.NewRecorder()
	server.Handler.ServeHTTP(response, request)
	if response.Code != http.StatusAccepted || fake.startRef.ID != "doc_abcdefgh" || fake.startRef.CollectionID != "kbs_abcdefgh" {
		t.Fatalf("status=%d ref=%+v body=%s", response.Code, fake.startRef, response.Body.String())
	}
}

func TestDocumentMetadataUpdateUsesFrozenPutContract(t *testing.T) {
	server, fake := newKnowledgeHTTPServer(t)
	request := knowledgeRequest(http.MethodPut, "/api/v1/knowledge-bases/kbs_abcdefgh/documents/doc_abcdefgh", `{"service":"checkout","tags":["prod","guide"]}`)
	response := httptest.NewRecorder()
	server.Handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || fake.updateRef.ID != "doc_abcdefgh" || fake.updateInput.Service != "checkout" || len(fake.updateInput.Tags) != 2 {
		t.Fatalf("status=%d ref=%+v input=%+v body=%s", response.Code, fake.updateRef, fake.updateInput, response.Body.String())
	}
}

func TestDeleteKnowledgeBaseRequiresFolderAdmin(t *testing.T) {
	server, _ := newKnowledgeHTTPServer(t)
	request := knowledgeRequest(http.MethodDelete, "/api/v1/knowledge-bases/kbs_abcdefgh", "")
	response := httptest.NewRecorder()
	server.Handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("write status=%d body=%s", response.Code, response.Body.String())
	}

	request = knowledgeRequest(http.MethodDelete, "/api/v1/knowledge-bases/kbs_abcdefgh", "")
	request.Header.Set("X-Aegis-Folder-Access", "admin")
	response = httptest.NewRecorder()
	server.Handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("admin status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestLegacyKnowledgeMigrationIsNotPublic(t *testing.T) {
	server, _ := newKnowledgeHTTPServer(t)
	request := knowledgeRequest(http.MethodPost, "/api/v1/knowledge-bases/kbs_abcdefgh/scope-migrations", "")
	response := httptest.NewRecorder()
	server.Handler.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
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
	request.Header.Set("X-Aegis-Folder-Access", "write")
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
	hits          []ports.KnowledgeCitation
	retrieveActor domain.ActorContext
	searchInput   ports.KnowledgeSearchInput
	listErr       error
	startRef      ports.KnowledgeDocumentRef
	updateRef     ports.KnowledgeDocumentRef
	updateInput   ports.UpdateKnowledgeDocumentInput
}

func (fake *knowledgeHTTPFake) ListKnowledgeBases(context.Context, domain.ActorContext, domain.PageRequest) (domain.Page[ports.KnowledgeBase], error) {
	return domain.Page[ports.KnowledgeBase]{Items: []ports.KnowledgeBase{}}, fake.listErr
}
func (fake *knowledgeHTTPFake) CreateKnowledgeBase(_ context.Context, actor domain.ActorContext, input ports.CreateKnowledgeBaseInput) (ports.KnowledgeBase, error) {
	fake.createCalls++
	fake.createActor, fake.createInput = actor, input
	return ports.KnowledgeBase{Ref: ports.KnowledgeBaseRef{ID: input.ID}, Name: input.Name, FolderUID: input.FolderUID}, nil
}
func (fake *knowledgeHTTPFake) UploadDocument(_ context.Context, _ domain.ActorContext, collection ports.KnowledgeCollectionRef, file ports.DocumentFile) (ports.KnowledgeDocument, error) {
	fake.uploadCalls++
	fake.uploadFile = file
	content, _ := io.ReadAll(file.Content)
	fake.uploadContent = string(content)
	return ports.KnowledgeDocument{Ref: ports.KnowledgeDocumentRef{ID: file.ID, CollectionID: collection.ID}, Name: file.Name, MediaType: file.MediaType, Service: file.Service, Tags: file.Tags, Status: domain.DocumentQueued, Size: file.Size}, nil
}
func (fake *knowledgeHTTPFake) Search(_ context.Context, actor domain.ActorContext, input ports.KnowledgeSearchInput) ([]ports.KnowledgeCitation, error) {
	fake.retrieveActor, fake.searchInput = actor, input
	return fake.hits, nil
}
func (fake *knowledgeHTTPFake) ListDocumentPassages(_ context.Context, actor domain.ActorContext, _ ports.KnowledgeDocumentRef, _ domain.PageRequest) (domain.Page[ports.DocumentPassage], error) {
	fake.retrieveActor = actor
	return domain.Page[ports.DocumentPassage]{Items: []ports.DocumentPassage{}}, nil
}
func (fake *knowledgeHTTPFake) RetryDocumentIndex(_ context.Context, _ domain.ActorContext, ref ports.KnowledgeDocumentRef) (ports.KnowledgeDocument, error) {
	fake.startRef = ref
	return ports.KnowledgeDocument{Ref: ref, Status: domain.DocumentQueued}, nil
}
func (fake *knowledgeHTTPFake) UpdateDocumentMetadata(_ context.Context, _ domain.ActorContext, ref ports.KnowledgeDocumentRef, input ports.UpdateKnowledgeDocumentInput) (ports.KnowledgeDocument, error) {
	fake.updateRef, fake.updateInput = ref, input
	return ports.KnowledgeDocument{Ref: ref, Name: "guide.md", MediaType: "text/markdown", Service: input.Service, Tags: input.Tags, Status: domain.DocumentReady}, nil
}

var _ ports.KnowledgeProvider = (*knowledgeHTTPFake)(nil)
