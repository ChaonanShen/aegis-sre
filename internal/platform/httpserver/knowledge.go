package httpserver

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"mime"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/1024XEngineer/aegis-sre/internal/domain"
	"github.com/1024XEngineer/aegis-sre/internal/ports"
)

const (
	maxKnowledgeJSONBytes int64 = 1 << 20
	maxKnowledgeFileBytes int64 = 10 << 20
	maxMultipartOverhead  int64 = 1 << 20
)

var supportedKnowledgeMedia = map[string]string{
	".pdf": "application/pdf",
	".md":  "text/markdown",
	".txt": "text/plain",
}

func registerKnowledgeHandlers(mux *http.ServeMux, provider ports.KnowledgeProvider, ids ports.KnowledgeIDGenerator) {
	if provider == nil || ids == nil {
		return
	}
	mux.HandleFunc("GET /api/v1/knowledge-bases", func(w http.ResponseWriter, request *http.Request) {
		actor, ok := requireKnowledgeActor(w, request, false)
		if !ok {
			return
		}
		limit, _ := strconv.Atoi(request.URL.Query().Get("limit"))
		page, err := provider.ListKnowledgeBases(request.Context(), actor, domain.PageRequest{Cursor: request.URL.Query().Get("cursor"), Limit: limit})
		if handleProviderError(w, request, err) {
			return
		}
		markResourceFolder(request, actor.FolderUID)
		items := make([]map[string]any, 0, len(page.Items))
		for _, item := range page.Items {
			items = append(items, knowledgeCollectionJSON(item))
		}
		writeJSON(w, http.StatusOK, pageJSON(items, page.NextCursor, page.HasMore))
	})
	mux.HandleFunc("POST /api/v1/knowledge-bases", func(w http.ResponseWriter, request *http.Request) {
		actor, ok := requireKnowledgeActor(w, request, true)
		if !ok {
			return
		}
		key, ok := requireIdempotencyKey(w, request)
		if !ok {
			return
		}
		var body struct {
			Name      string `json:"name"`
			FolderUID string `json:"folder_uid"`
		}
		if !decodeJSONBody(w, request, &body, maxKnowledgeJSONBytes) {
			return
		}
		if !validKnowledgeText(body.Name, 200) || body.FolderUID != actor.FolderUID {
			code, detail := "invalid_argument", "knowledge base name is required and must not exceed 200 characters"
			status := http.StatusBadRequest
			if body.FolderUID != actor.FolderUID {
				status, code, detail = http.StatusForbidden, "forbidden", "folder context does not match trusted actor context"
			}
			writeAPIProblem(w, request, status, code, detail, false)
			return
		}
		id, err := ids.CollectionID(actor, key)
		if handleProviderError(w, request, err) {
			return
		}
		collection, err := provider.CreateKnowledgeBase(request.Context(), actor, ports.CreateKnowledgeBaseInput{ID: id, Name: strings.TrimSpace(body.Name), FolderUID: body.FolderUID})
		if handleProviderError(w, request, err) {
			return
		}
		markResourceFolder(request, collection.FolderUID)
		writeJSON(w, http.StatusCreated, knowledgeCollectionJSON(collection))
	})
	mux.HandleFunc("GET /api/v1/knowledge-bases/{knowledge_base_id}", func(w http.ResponseWriter, request *http.Request) {
		actor, ref, ok := knowledgeCollectionRequest(w, request, false)
		if !ok {
			return
		}
		collection, err := provider.GetKnowledgeBase(request.Context(), actor, ref)
		if handleProviderError(w, request, err) {
			return
		}
		markResourceFolder(request, collection.FolderUID)
		writeJSON(w, http.StatusOK, knowledgeCollectionJSON(collection))
	})
	mux.HandleFunc("PUT /api/v1/knowledge-bases/{knowledge_base_id}", func(w http.ResponseWriter, request *http.Request) {
		actor, ref, ok := knowledgeCollectionRequest(w, request, true)
		if !ok {
			return
		}
		var body struct {
			Name string `json:"name"`
		}
		if !decodeJSONBody(w, request, &body, maxKnowledgeJSONBytes) {
			return
		}
		if !validKnowledgeText(body.Name, 200) {
			writeAPIProblem(w, request, http.StatusBadRequest, "invalid_argument", "valid knowledge base name is required", false)
			return
		}
		collection, err := provider.UpdateKnowledgeBase(request.Context(), actor, ref, ports.UpdateKnowledgeBaseInput{Name: strings.TrimSpace(body.Name)})
		if handleProviderError(w, request, err) {
			return
		}
		markResourceFolder(request, collection.FolderUID)
		writeJSON(w, http.StatusOK, knowledgeCollectionJSON(collection))
	})
	mux.HandleFunc("DELETE /api/v1/knowledge-bases/{knowledge_base_id}", func(w http.ResponseWriter, request *http.Request) {
		actor, ref, ok := knowledgeCollectionRequestWithAccess(w, request, folderAccessAdmin)
		if !ok {
			return
		}
		if handleProviderError(w, request, provider.DeleteKnowledgeBase(request.Context(), actor, ref)) {
			return
		}
		markResourceFolder(request, actor.FolderUID)
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("GET /api/v1/knowledge-bases/{knowledge_base_id}/documents", func(w http.ResponseWriter, request *http.Request) {
		actor, ref, ok := knowledgeCollectionRequest(w, request, false)
		if !ok {
			return
		}
		limit, _ := strconv.Atoi(request.URL.Query().Get("limit"))
		page, err := provider.ListDocuments(request.Context(), actor, ref, domain.PageRequest{Cursor: request.URL.Query().Get("cursor"), Limit: limit})
		if handleProviderError(w, request, err) {
			return
		}
		markResourceFolder(request, actor.FolderUID)
		items := make([]map[string]any, 0, len(page.Items))
		for _, item := range page.Items {
			items = append(items, knowledgeDocumentJSON(item))
		}
		writeJSON(w, http.StatusOK, pageJSON(items, page.NextCursor, page.HasMore))
	})
	mux.HandleFunc("POST /api/v1/knowledge-bases/{knowledge_base_id}/documents", func(w http.ResponseWriter, request *http.Request) {
		actor, collectionRef, ok := knowledgeCollectionRequest(w, request, true)
		if !ok {
			return
		}
		key, ok := requireIdempotencyKey(w, request)
		if !ok {
			return
		}
		documentID, err := ids.DocumentID(collectionRef.ID, key)
		if handleProviderError(w, request, err) {
			return
		}
		file, cleanup, ok := readKnowledgeUpload(w, request, documentID)
		if !ok {
			return
		}
		defer cleanup()
		document, err := provider.UploadDocument(request.Context(), actor, collectionRef, file)
		if handleProviderError(w, request, err) {
			return
		}
		markResourceFolder(request, actor.FolderUID)
		writeJSON(w, http.StatusAccepted, knowledgeDocumentJSON(document))
	})

	mux.HandleFunc("GET /api/v1/knowledge-bases/{knowledge_base_id}/documents/{document_id}", func(w http.ResponseWriter, request *http.Request) {
		actor, ref, ok := knowledgeDocumentRequest(w, request, false)
		if !ok {
			return
		}
		document, err := provider.GetDocument(request.Context(), actor, ref)
		if handleProviderError(w, request, err) {
			return
		}
		markResourceFolder(request, actor.FolderUID)
		writeJSON(w, http.StatusOK, knowledgeDocumentJSON(document))
	})
	updateDocument := func(w http.ResponseWriter, request *http.Request) {
		actor, ref, ok := knowledgeDocumentRequest(w, request, true)
		if !ok {
			return
		}
		var body struct {
			Service string   `json:"service"`
			Tags    []string `json:"tags"`
		}
		if !decodeJSONBody(w, request, &body, maxKnowledgeJSONBytes) || !validateDocumentMetadata(w, request, body.Service, body.Tags) {
			return
		}
		document, err := provider.UpdateDocumentMetadata(request.Context(), actor, ref, ports.UpdateKnowledgeDocumentInput{Service: strings.TrimSpace(body.Service), Tags: body.Tags})
		if handleProviderError(w, request, err) {
			return
		}
		markResourceFolder(request, actor.FolderUID)
		writeJSON(w, http.StatusOK, knowledgeDocumentJSON(document))
	}
	// PUT 是冻结公共契约；PATCH 仅保留给迁移期客户端，至少跨过兼容窗口后再删除。
	mux.HandleFunc("PUT /api/v1/knowledge-bases/{knowledge_base_id}/documents/{document_id}", updateDocument)
	mux.HandleFunc("PATCH /api/v1/knowledge-bases/{knowledge_base_id}/documents/{document_id}", updateDocument)
	mux.HandleFunc("DELETE /api/v1/knowledge-bases/{knowledge_base_id}/documents/{document_id}", func(w http.ResponseWriter, request *http.Request) {
		actor, ref, ok := knowledgeDocumentRequest(w, request, true)
		if !ok {
			return
		}
		if handleProviderError(w, request, provider.DeleteDocument(request.Context(), actor, ref)) {
			return
		}
		markResourceFolder(request, actor.FolderUID)
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("POST /api/v1/knowledge-bases/{knowledge_base_id}/documents/{document_action}", func(w http.ResponseWriter, request *http.Request) {
		documentID, action, found := strings.Cut(request.PathValue("document_action"), ":")
		if !found || action != "retry-index" {
			writeAPIProblem(w, request, http.StatusNotFound, "not_found", "document action not found", false)
			return
		}
		request.SetPathValue("document_id", documentID)
		actor, ref, ok := knowledgeDocumentRequest(w, request, true)
		if !ok {
			return
		}
		document, err := provider.RetryDocumentIndex(request.Context(), actor, ref)
		if handleProviderError(w, request, err) {
			return
		}
		markResourceFolder(request, actor.FolderUID)
		writeJSON(w, http.StatusAccepted, knowledgeDocumentJSON(document))
	})
	mux.HandleFunc("GET /api/v1/knowledge-bases/{knowledge_base_id}/documents/{document_id}/passages", func(w http.ResponseWriter, request *http.Request) {
		actor, ref, ok := knowledgeDocumentRequest(w, request, false)
		if !ok {
			return
		}
		limit, _ := strconv.Atoi(request.URL.Query().Get("limit"))
		page, err := provider.ListDocumentPassages(request.Context(), actor, ref, domain.PageRequest{Cursor: request.URL.Query().Get("cursor"), Limit: limit})
		if handleProviderError(w, request, err) {
			return
		}
		markResourceFolder(request, actor.FolderUID)
		items := make([]map[string]any, 0, len(page.Items))
		for _, item := range page.Items {
			value := map[string]any{"ordinal": item.Ordinal, "text": item.Text}
			if item.Location != "" {
				value["location"] = item.Location
			}
			items = append(items, value)
		}
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, http.StatusOK, pageJSON(items, page.NextCursor, page.HasMore))
	})
	mux.HandleFunc("GET /api/v1/knowledge-bases/{knowledge_base_id}/documents/{document_id}/content", func(w http.ResponseWriter, request *http.Request) {
		actor, ref, ok := knowledgeDocumentRequest(w, request, false)
		if !ok {
			return
		}
		download, err := provider.DownloadDocument(request.Context(), actor, ref)
		if handleProviderError(w, request, err) {
			return
		}
		markResourceFolder(request, actor.FolderUID)
		defer download.Content.Close()
		w.Header().Set("Content-Type", download.MediaType)
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": download.Name}))
		w.Header().Set("Cache-Control", "no-store")
		_, _ = io.Copy(w, download.Content)
	})

	mux.HandleFunc("POST /api/v1/knowledge:search", func(w http.ResponseWriter, request *http.Request) {
		actor, ok := requireKnowledgeActor(w, request, false)
		if !ok {
			return
		}
		var body struct {
			Query            string      `json:"query"`
			KnowledgeBaseIDs []domain.ID `json:"knowledge_base_ids"`
			Service          string      `json:"service"`
			TagsAny          []string    `json:"tags_any"`
			TagsAll          []string    `json:"tags_all"`
			Limit            int         `json:"limit"`
		}
		if !decodeJSONBody(w, request, &body, maxKnowledgeJSONBytes) {
			return
		}
		if body.Limit == 0 {
			body.Limit = 5
		}
		if !validKnowledgeText(body.Query, 2000) || len(body.KnowledgeBaseIDs) == 0 || len(body.KnowledgeBaseIDs) > 20 || !validKnowledgeTextOrEmpty(body.Service, 128) || !validSearchTags(body.TagsAny, body.TagsAll) {
			writeAPIProblem(w, request, http.StatusBadRequest, "invalid_argument", "invalid knowledge search request", false)
			return
		}
		collections := make([]ports.KnowledgeCollectionRef, 0, len(body.KnowledgeBaseIDs))
		for _, id := range body.KnowledgeBaseIDs {
			if !id.Valid() || !strings.HasPrefix(string(id), "kbs_") {
				writeAPIProblem(w, request, http.StatusBadRequest, "invalid_argument", "invalid knowledge base ID", false)
				return
			}
			collections = append(collections, ports.KnowledgeCollectionRef{ID: id})
		}
		hits, err := provider.Search(request.Context(), actor, ports.KnowledgeSearchInput{Query: strings.TrimSpace(body.Query), KnowledgeBases: collections, Service: strings.TrimSpace(body.Service), TagsAny: body.TagsAny, TagsAll: body.TagsAll, Limit: body.Limit})
		if handleProviderError(w, request, err) {
			return
		}
		markResourceFolder(request, actor.FolderUID)
		items := make([]map[string]any, 0, len(hits))
		for _, hit := range hits {
			citation := map[string]any{"document_id": hit.Document.ID, "knowledge_base_id": hit.Document.CollectionID, "source_name": hit.SourceName, "ordinal": hit.Ordinal}
			if hit.Location != "" {
				citation["location"] = hit.Location
			}
			items = append(items, map[string]any{"text": hit.Text, "citation": citation})
		}
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, http.StatusOK, map[string]any{"hits": items})
	})
}

func requireKnowledgeActor(w http.ResponseWriter, request *http.Request, write bool) (domain.ActorContext, bool) {
	required := folderAccessRead
	if write {
		required = folderAccessWrite
	}
	return requireFolderAccess(w, request, required)
}

func knowledgeCollectionRequest(w http.ResponseWriter, request *http.Request, write bool) (domain.ActorContext, ports.KnowledgeCollectionRef, bool) {
	required := folderAccessRead
	if write {
		required = folderAccessWrite
	}
	return knowledgeCollectionRequestWithAccess(w, request, required)
}

func knowledgeCollectionRequestWithAccess(w http.ResponseWriter, request *http.Request, required folderAccess) (domain.ActorContext, ports.KnowledgeCollectionRef, bool) {
	actor, ok := requireFolderAccess(w, request, required)
	if !ok {
		return domain.ActorContext{}, ports.KnowledgeCollectionRef{}, false
	}
	id := domain.ID(request.PathValue("knowledge_base_id"))
	if !id.Valid() || !strings.HasPrefix(string(id), "kbs_") {
		writeAPIProblem(w, request, http.StatusBadRequest, "invalid_argument", "invalid knowledge base ID", false)
		return domain.ActorContext{}, ports.KnowledgeCollectionRef{}, false
	}
	return actor, ports.KnowledgeCollectionRef{ID: id}, true
}

func knowledgeDocumentRequest(w http.ResponseWriter, request *http.Request, write bool) (domain.ActorContext, ports.KnowledgeDocumentRef, bool) {
	actor, collection, ok := knowledgeCollectionRequest(w, request, write)
	if !ok {
		return domain.ActorContext{}, ports.KnowledgeDocumentRef{}, false
	}
	id := domain.ID(request.PathValue("document_id"))
	if !id.Valid() || !strings.HasPrefix(string(id), "doc_") {
		writeAPIProblem(w, request, http.StatusBadRequest, "invalid_argument", "invalid document ID", false)
		return domain.ActorContext{}, ports.KnowledgeDocumentRef{}, false
	}
	return actor, ports.KnowledgeDocumentRef{ID: id, CollectionID: collection.ID}, true
}

func readKnowledgeUpload(w http.ResponseWriter, request *http.Request, documentID domain.ID) (ports.DocumentFile, func(), bool) {
	if !strings.HasPrefix(strings.ToLower(request.Header.Get("Content-Type")), "multipart/form-data") {
		writeAPIProblem(w, request, http.StatusUnsupportedMediaType, "invalid_argument", "multipart document upload is required", false)
		return ports.DocumentFile{}, func() {}, false
	}
	request.Body = http.MaxBytesReader(w, request.Body, maxKnowledgeFileBytes+maxMultipartOverhead)
	if err := request.ParseMultipartForm(2 << 20); err != nil {
		writeAPIProblem(w, request, http.StatusBadRequest, "invalid_argument", "document upload is invalid or too large", false)
		return ports.DocumentFile{}, func() {}, false
	}
	cleanup := func() { _ = request.MultipartForm.RemoveAll() }
	file, header, err := request.FormFile("file")
	if err != nil {
		cleanup()
		writeAPIProblem(w, request, http.StatusBadRequest, "invalid_argument", "document file is required", false)
		return ports.DocumentFile{}, func() {}, false
	}
	name := filepath.Base(header.Filename)
	extension := strings.ToLower(filepath.Ext(name))
	mediaType, supported := supportedKnowledgeMedia[extension]
	if !supported || !validKnowledgeText(name, 512) || header.Size < 0 || header.Size > maxKnowledgeFileBytes {
		_ = file.Close()
		cleanup()
		writeAPIProblem(w, request, http.StatusBadRequest, "invalid_argument", "unsupported or oversized document", false)
		return ports.DocumentFile{}, func() {}, false
	}
	service := strings.TrimSpace(request.FormValue("service"))
	tags := append([]string(nil), request.MultipartForm.Value["tags"]...)
	if !validateDocumentMetadata(w, request, service, tags) {
		_ = file.Close()
		cleanup()
		return ports.DocumentFile{}, func() {}, false
	}
	hash := sha256.New()
	written, err := io.Copy(hash, io.LimitReader(file, maxKnowledgeFileBytes+1))
	if err != nil || written > maxKnowledgeFileBytes {
		_ = file.Close()
		cleanup()
		writeAPIProblem(w, request, http.StatusBadRequest, "invalid_argument", "document upload is invalid or too large", false)
		return ports.DocumentFile{}, func() {}, false
	}
	seeker, ok := file.(io.ReadSeeker)
	if !ok {
		_ = file.Close()
		cleanup()
		writeAPIProblem(w, request, http.StatusInternalServerError, "internal", "document upload cannot be processed", false)
		return ports.DocumentFile{}, func() {}, false
	}
	if !validKnowledgeContent(seeker, extension) {
		_ = file.Close()
		cleanup()
		writeAPIProblem(w, request, http.StatusBadRequest, "invalid_argument", "document content does not match its supported format", false)
		return ports.DocumentFile{}, func() {}, false
	}
	if _, err := seeker.Seek(0, io.SeekStart); err != nil {
		_ = file.Close()
		cleanup()
		writeAPIProblem(w, request, http.StatusInternalServerError, "internal", "document upload cannot be processed", false)
		return ports.DocumentFile{}, func() {}, false
	}
	return ports.DocumentFile{ID: documentID, Name: name, MediaType: mediaType, Service: service, Tags: tags, Size: written, SHA256: hex.EncodeToString(hash.Sum(nil)), Content: file}, func() { _ = file.Close(); cleanup() }, true
}

func validKnowledgeContent(content io.ReadSeeker, extension string) bool {
	if _, err := content.Seek(0, io.SeekStart); err != nil {
		return false
	}
	sample := make([]byte, 4096)
	read, err := content.Read(sample)
	if err != nil && err != io.EOF {
		return false
	}
	sample = sample[:read]
	if extension == ".pdf" {
		return len(sample) >= 5 && string(sample[:5]) == "%PDF-"
	}
	return utf8.Valid(sample) && !strings.ContainsRune(string(sample), '\x00')
}

func validateDocumentMetadata(w http.ResponseWriter, request *http.Request, service string, tags []string) bool {
	if !validKnowledgeTextOrEmpty(service, 128) || len(tags) > 32 {
		writeAPIProblem(w, request, http.StatusBadRequest, "invalid_argument", "invalid document service or tags", false)
		return false
	}
	for _, tag := range tags {
		if !validKnowledgeText(tag, 64) {
			writeAPIProblem(w, request, http.StatusBadRequest, "invalid_argument", "invalid document service or tags", false)
			return false
		}
	}
	return true
}

func validKnowledgeText(value string, max int) bool {
	trimmed := strings.TrimSpace(value)
	return trimmed != "" && utf8.ValidString(trimmed) && utf8.RuneCountInString(trimmed) <= max && !strings.ContainsRune(trimmed, '\x00')
}

func validKnowledgeTextOrEmpty(value string, max int) bool {
	return value == "" || validKnowledgeText(value, max)
}

func knowledgeCollectionJSON(collection ports.KnowledgeBase) map[string]any {
	return map[string]any{"id": collection.Ref.ID, "name": collection.Name, "folder_uid": collection.FolderUID, "created_at": collection.CreatedAt, "updated_at": collection.UpdatedAt}
}

func validSearchTags(groups ...[]string) bool {
	total := 0
	for _, tags := range groups {
		total += len(tags)
		for _, tag := range tags {
			if !validKnowledgeText(tag, 64) {
				return false
			}
		}
	}
	return total <= 32
}

func knowledgeDocumentJSON(document ports.KnowledgeDocument) map[string]any {
	value := map[string]any{"id": document.Ref.ID, "knowledge_base_id": document.Ref.CollectionID, "name": document.Name, "media_type": document.MediaType, "service": document.Service, "tags": document.Tags, "status": document.Status, "size": document.Size}
	if document.FailureReason != "" {
		value["failure_reason"] = document.FailureReason
	}
	if !document.CreatedAt.IsZero() {
		value["created_at"] = document.CreatedAt
	}
	if !document.UpdatedAt.IsZero() {
		value["updated_at"] = document.UpdatedAt
	}
	return value
}

func pageJSON(items any, cursor string, hasMore bool) map[string]any {
	value := map[string]any{"items": items, "has_more": hasMore}
	if cursor != "" {
		value["next_cursor"] = cursor
	}
	return value
}
