import {
  DocumentUploadInput,
  KnowledgeBaseRecord,
  KnowledgeChunkRecord,
  KnowledgeDocumentRecord,
  KnowledgeSearchHit,
  KnowledgeSearchInput,
} from '../managementModel';

export interface KnowledgeManagementGateway {
  listKnowledgeBases(folderUid: string, signal?: AbortSignal): Promise<KnowledgeBaseRecord[]>;
  createKnowledgeBase(
    folderUid: string,
    name: string,
    idempotencyKey: string,
    signal?: AbortSignal
  ): Promise<KnowledgeBaseRecord>;
  updateKnowledgeBase(
    folderUid: string,
    id: string,
    input: { name: string; status: 'active' | 'disabled' },
    signal?: AbortSignal
  ): Promise<KnowledgeBaseRecord>;
  deleteKnowledgeBase(folderUid: string, id: string, signal?: AbortSignal): Promise<void>;
  listDocuments(folderUid: string, knowledgeBaseId: string, signal?: AbortSignal): Promise<KnowledgeDocumentRecord[]>;
  getDocument(
    folderUid: string,
    knowledgeBaseId: string,
    documentId: string,
    signal?: AbortSignal
  ): Promise<KnowledgeDocumentRecord>;
  uploadDocument(
    folderUid: string,
    knowledgeBaseId: string,
    input: DocumentUploadInput,
    signal?: AbortSignal
  ): Promise<KnowledgeDocumentRecord>;
  updateDocument(
    folderUid: string,
    knowledgeBaseId: string,
    documentId: string,
    input: { service: string; tags: string[] },
    signal?: AbortSignal
  ): Promise<KnowledgeDocumentRecord>;
  deleteDocument(folderUid: string, knowledgeBaseId: string, documentId: string, signal?: AbortSignal): Promise<void>;
  startIndexing(folderUid: string, knowledgeBaseId: string, documentId: string, signal?: AbortSignal): Promise<void>;
  stopIndexing(folderUid: string, knowledgeBaseId: string, documentId: string, signal?: AbortSignal): Promise<void>;
  listChunks(
    folderUid: string,
    knowledgeBaseId: string,
    documentId: string,
    signal?: AbortSignal
  ): Promise<KnowledgeChunkRecord[]>;
  downloadDocument(folderUid: string, knowledgeBaseId: string, documentId: string, signal?: AbortSignal): Promise<Blob>;
  search(folderUid: string, input: KnowledgeSearchInput, signal?: AbortSignal): Promise<KnowledgeSearchHit[]>;
}
