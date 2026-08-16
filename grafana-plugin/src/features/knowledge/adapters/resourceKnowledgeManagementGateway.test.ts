import { BackendSrv, BackendSrvRequest, FetchResponse } from '@grafana/runtime';
import { of } from 'rxjs';
import { createResourceKnowledgeManagementGateway } from './resourceKnowledgeManagementGateway';

const kb = {
  id: 'kbs_abcdefgh',
  name: 'Operations',
  folder_uid: 'ops',
  created_at: '2026-08-14T00:00:00Z',
  updated_at: '2026-08-14T00:00:00Z',
} as const;
const document = {
  id: 'doc_abcdefgh',
  knowledge_base_id: kb.id,
  name: 'guide.md',
  media_type: 'text/markdown',
  service: 'api',
  tags: ['prod'],
  status: 'queued',
  size: 12,
} as const;

describe('Control Plane Knowledge management gateway', () => {
  test('reads explicit Knowledge capability state before product requests', async () => {
    const backend = fakeBackend([
      { items: [{ name: 'knowledge', status: 'degraded', reason: 'index queue delayed' }] },
    ]);
    const gateway = createResourceKnowledgeManagementGateway({ backendSrv: backend });

    await expect(gateway.getAvailability()).resolves.toEqual({
      status: 'degraded',
      reason: 'index queue delayed',
    });
  });

  test('paginates knowledge bases and sends the trusted folder scope on every page', async () => {
    const backend = fakeBackend([
      { items: [kb], has_more: true, next_cursor: 'next page' },
      { items: [{ ...kb, id: 'kbs_second' }], has_more: false },
    ]);
    const gateway = createResourceKnowledgeManagementGateway({ backendSrv: backend });

    await expect(gateway.listKnowledgeBases('ops')).resolves.toHaveLength(2);
    const requests = calls(backend);
    expect(requests[0]).toEqual(expect.objectContaining({ headers: { 'X-Aegis-Folder-UID': 'ops' } }));
    expect(requests[1].url).toContain('cursor=next%20page');
  });

  test('rejects a truncated provider pagination response', async () => {
    const gateway = createResourceKnowledgeManagementGateway({
      backendSrv: fakeBackend([{ items: [], has_more: true }]),
    });
    await expect(gateway.listKnowledgeBases('ops')).rejects.toMatchObject({ code: 'provider_unavailable' });
  });

  test('uses caller idempotency keys for create and multipart upload without overriding the boundary', async () => {
    const backend = fakeBackend([kb, document]);
    const gateway = createResourceKnowledgeManagementGateway({ backendSrv: backend });
    await gateway.createKnowledgeBase('ops', 'Operations', 'create-kb-123');
    const file = new File(['# guide'], 'guide.md', { type: 'text/markdown' });
    await gateway.uploadDocument('ops', kb.id, {
      file,
      service: 'api',
      tags: ['prod', 'guide'],
      idempotencyKey: 'upload-doc-123',
    });

    const requests = calls(backend);
    expect(requests[0]).toEqual(
      expect.objectContaining({
        method: 'POST',
        data: { name: 'Operations', folder_uid: 'ops' },
        headers: { 'X-Aegis-Folder-UID': 'ops', 'Idempotency-Key': 'create-kb-123' },
      })
    );
    expect(requests[1].data).toBeInstanceOf(FormData);
    expect(requests[1].headers).toEqual({ 'X-Aegis-Folder-UID': 'ops', 'Idempotency-Key': 'upload-doc-123' });
    expect((requests[1].data as FormData).getAll('tags')).toEqual(['prod', 'guide']);
  });

  test('forwards retry and product search filters without Provider scoring fields', async () => {
    const hit = {
      text: 'restart it',
      citation: {
        document_id: document.id,
        knowledge_base_id: kb.id,
        source_name: document.name,
        ordinal: 1,
        location: 'p1',
      },
    };
    const backend = fakeBackend([document, undefined, { hits: [hit] }]);
    const gateway = createResourceKnowledgeManagementGateway({ backendSrv: backend });
    await gateway.retryDocumentIndex('ops', kb.id, document.id);
    await gateway.deleteDocument('ops', kb.id, document.id);
    await expect(
      gateway.search('ops', {
        query: 'restart',
        knowledgeBaseIds: [kb.id],
        tagsAny: ['guide'],
        tagsAll: ['prod'],
        limit: 5,
      })
    ).resolves.toEqual([hit]);

    const requests = calls(backend);
    expect(requests.map((request) => request.url)).toEqual([
      expect.stringContaining(`${document.id}:retry-index`),
      expect.stringContaining(document.id),
      expect.stringContaining('/knowledge:search'),
    ]);
    expect(requests[2].data).toEqual({
      query: 'restart',
      knowledge_base_ids: [kb.id],
      tags_any: ['guide'],
      tags_all: ['prod'],
      limit: 5,
    });
  });

  test('rejects missing folder scope before any network request', async () => {
    const backend = fakeBackend([]);
    const gateway = createResourceKnowledgeManagementGateway({ backendSrv: backend });
    await expect(gateway.listKnowledgeBases(' ')).rejects.toMatchObject({ code: 'invalid_argument' });
    expect(backend.fetch).not.toHaveBeenCalled();
  });
});

function fakeBackend(values: unknown[]): BackendSrv {
  const queue = [...values];
  return { fetch: jest.fn(() => of(response(queue.shift()))) } as unknown as BackendSrv;
}
function calls(backend: BackendSrv): BackendSrvRequest[] {
  return (backend.fetch as jest.Mock).mock.calls.map(([request]) => request as BackendSrvRequest);
}
function response(data: unknown): FetchResponse<unknown> {
  return {
    data,
    status: 200,
    statusText: 'OK',
    ok: true,
    headers: new Headers(),
    config: { url: '' },
  } as FetchResponse<unknown>;
}
