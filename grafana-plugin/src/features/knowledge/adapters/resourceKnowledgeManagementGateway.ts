import { BackendSrv, getBackendSrv } from '@grafana/runtime';
import type { components } from '../../../api/generated/controlPlane';
import { ResourceClient, ResourceClientError } from '../../../adapters/resourcesdk/resourceClient';
import { KnowledgeManagementGateway } from '../ports/KnowledgeManagementGateway';

type KnowledgeBase = components['schemas']['KnowledgeBase'];
type KnowledgeBasePage = components['schemas']['KnowledgeBasePage'];
type Document = components['schemas']['Document'];
type DocumentPage = components['schemas']['DocumentPage'];
type ChunkPage = components['schemas']['KnowledgeChunkPage'];
type SearchResponse = components['schemas']['KnowledgeSearchResponse'];

export function createResourceKnowledgeManagementGateway(
  options: { backendSrv?: BackendSrv; resourceClient?: ResourceClient } = {}
): KnowledgeManagementGateway {
  let resources: ResourceClient | undefined;
  const client = () =>
    (resources ??= options.resourceClient ?? new ResourceClient(options.backendSrv ?? getBackendSrv()));
  const headers = (folderUid: string) => ({ 'X-Aegis-Folder-UID': requireFolder(folderUid) });

  return {
    async listKnowledgeBases(folderUid, signal) {
      return collectPages(
        async (cursor) =>
          client().request(
            `/api/v1/knowledge-bases?folder_uid=${encodeURIComponent(folderUid)}${cursorQuery(cursor)}`,
            isKnowledgeBasePage,
            { headers: headers(folderUid), signal }
          ),
        'Knowledge Base'
      );
    },
    createKnowledgeBase(folderUid, name, idempotencyKey, signal) {
      return client().request('/api/v1/knowledge-bases', isKnowledgeBase, {
        method: 'POST',
        data: { name, folder_uid: folderUid },
        headers: { ...headers(folderUid), 'Idempotency-Key': idempotencyKey },
        signal,
      });
    },
    updateKnowledgeBase(folderUid, id, input, signal) {
      return client().request(kbPath(id), isKnowledgeBase, {
        method: 'PUT',
        data: input,
        headers: headers(folderUid),
        signal,
      });
    },
    deleteKnowledgeBase(folderUid, id, signal) {
      return client().requestVoid(kbPath(id), { method: 'DELETE', headers: headers(folderUid), signal });
    },
    async listDocuments(folderUid, knowledgeBaseId, signal) {
      return collectPages(
        async (cursor) =>
          client().request(`${kbPath(knowledgeBaseId)}/documents${pageQuery(cursor)}`, isDocumentPage, {
            headers: headers(folderUid),
            signal,
          }),
        'Document'
      );
    },
    getDocument(folderUid, knowledgeBaseId, documentId, signal) {
      return client().request(documentPath(knowledgeBaseId, documentId), isDocument, {
        headers: headers(folderUid),
        signal,
      });
    },
    uploadDocument(folderUid, knowledgeBaseId, input, signal) {
      const form = new FormData();
      form.append('file', input.file);
      if (input.service) form.append('service', input.service);
      for (const tag of input.tags ?? []) form.append('tags', tag);
      return client().request(`${kbPath(knowledgeBaseId)}/documents`, isDocument, {
        method: 'POST',
        data: form,
        // 浏览器必须自行设置 multipart boundary，不能手工设置 Content-Type。
        headers: { ...headers(folderUid), 'Idempotency-Key': input.idempotencyKey },
        signal,
      });
    },
    updateDocument(folderUid, knowledgeBaseId, documentId, input, signal) {
      return client().request(documentPath(knowledgeBaseId, documentId), isDocument, {
        method: 'PUT',
        data: input,
        headers: headers(folderUid),
        signal,
      });
    },
    deleteDocument(folderUid, knowledgeBaseId, documentId, signal) {
      return client().requestVoid(documentPath(knowledgeBaseId, documentId), {
        method: 'DELETE',
        headers: headers(folderUid),
        signal,
      });
    },
    startIndexing(folderUid, knowledgeBaseId, documentId, signal) {
      return client().requestVoid(`${documentPath(knowledgeBaseId, documentId)}:index`, {
        method: 'POST',
        headers: headers(folderUid),
        signal,
      });
    },
    stopIndexing(folderUid, knowledgeBaseId, documentId, signal) {
      return client().requestVoid(`${documentPath(knowledgeBaseId, documentId)}:stop`, {
        method: 'POST',
        headers: headers(folderUid),
        signal,
      });
    },
    async listChunks(folderUid, knowledgeBaseId, documentId, signal) {
      return collectPages(
        async (cursor) =>
          client().request(`${documentPath(knowledgeBaseId, documentId)}/chunks${pageQuery(cursor)}`, isChunkPage, {
            headers: headers(folderUid),
            signal,
          }),
        'Chunk'
      );
    },
    downloadDocument(folderUid, knowledgeBaseId, documentId, signal) {
      return client().requestBlob(`${documentPath(knowledgeBaseId, documentId)}/content`, {
        headers: headers(folderUid),
        signal,
      });
    },
    async search(folderUid, input, signal) {
      const response = await client().request('/api/v1/knowledge/search', isSearchResponse, {
        method: 'POST',
        data: {
          query: input.query,
          knowledge_base_ids: input.knowledgeBaseIds,
          ...(input.service ? { service: input.service } : {}),
          limit: input.limit,
          threshold: input.threshold,
        },
        headers: headers(folderUid),
        signal,
      });
      return response.hits;
    },
  };
}

interface Page<T> {
  items: T[];
  has_more: boolean;
  next_cursor?: string;
}

async function collectPages<T>(fetchPage: (cursor: string) => Promise<Page<T>>, resource: string): Promise<T[]> {
  const items: T[] = [];
  let cursor = '';
  do {
    const page = await fetchPage(cursor);
    items.push(...page.items);
    cursor = page.has_more ? (page.next_cursor ?? '') : '';
    if (page.has_more && !cursor) {
      throw new ResourceClientError(502, 'provider_unavailable', `${resource} 分页响应缺少 next_cursor。`);
    }
  } while (cursor);
  return items;
}

function kbPath(id: string): string {
  return `/api/v1/knowledge-bases/${encodeURIComponent(id)}`;
}
function documentPath(kbId: string, documentId: string): string {
  return `${kbPath(kbId)}/documents/${encodeURIComponent(documentId)}`;
}
function cursorQuery(cursor: string): string {
  return cursor ? `&cursor=${encodeURIComponent(cursor)}` : '';
}
function pageQuery(cursor: string): string {
  return cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
}
function requireFolder(folderUid: string): string {
  if (!folderUid.trim()) throw new ResourceClientError(0, 'invalid_argument', '必须选择 Folder。');
  return folderUid;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
function isPage(value: unknown): value is Page<unknown> {
  return (
    isObject(value) &&
    Array.isArray(value.items) &&
    typeof value.has_more === 'boolean' &&
    (value.next_cursor === undefined || typeof value.next_cursor === 'string')
  );
}
function isKnowledgeBase(value: unknown): value is KnowledgeBase {
  return (
    isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.folder_uid === 'string' &&
    (value.status === 'active' || value.status === 'disabled') &&
    typeof value.created_at === 'string' &&
    typeof value.updated_at === 'string'
  );
}
function isKnowledgeBasePage(value: unknown): value is KnowledgeBasePage {
  return isPage(value) && value.items.every(isKnowledgeBase);
}
function isDocument(value: unknown): value is Document {
  return (
    isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.knowledge_base_id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.media_type === 'string' &&
    typeof value.service === 'string' &&
    isStringArray(value.tags) &&
    ['pending', 'indexing', 'ready', 'failed', 'disabled'].includes(String(value.status)) &&
    typeof value.size === 'number' &&
    (value.failure_reason === undefined || typeof value.failure_reason === 'string')
  );
}
function isDocumentPage(value: unknown): value is DocumentPage {
  return isPage(value) && value.items.every(isDocument);
}
function isChunk(value: unknown): value is components['schemas']['KnowledgeChunk'] {
  return (
    isObject(value) &&
    typeof value.id === 'string' &&
    typeof value.document_id === 'string' &&
    typeof value.text === 'string' &&
    typeof value.position === 'string' &&
    typeof value.page_number === 'number'
  );
}
function isChunkPage(value: unknown): value is ChunkPage {
  return isPage(value) && value.items.every(isChunk);
}
function isSearchResponse(value: unknown): value is SearchResponse {
  return (
    isObject(value) &&
    Array.isArray(value.hits) &&
    value.hits.every(
      (hit) =>
        isObject(hit) &&
        typeof hit.text === 'string' &&
        typeof hit.score === 'number' &&
        isObject(hit.citation) &&
        typeof hit.citation.document_id === 'string' &&
        typeof hit.citation.source_name === 'string' &&
        typeof hit.citation.position === 'string' &&
        typeof hit.citation.page_number === 'number'
    )
  );
}
