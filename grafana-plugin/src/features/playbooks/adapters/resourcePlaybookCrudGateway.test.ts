import { BackendSrv, BackendSrvRequest, FetchResponse } from '@grafana/runtime';
import { of } from 'rxjs';
import { createResourcePlaybookCrudGateway } from './resourcePlaybookCrudGateway';

const source = `name: diagnose
description: Diagnose service
steps: []
`;

describe('Control Plane Playbook CRUD gateway', () => {
  test('lists summaries without N+1 detail requests', async () => {
    const backend = fakeBackend([{ items: [{ id: 'pbk_scope_abcdefgh', name: 'diagnose', description: 'Diagnose service', status: 'active' }], has_more: false }]);
    const gateway = createResourcePlaybookCrudGateway({ backendSrv: backend });
    await expect(gateway.listPlaybooks()).resolves.toEqual([
      { id: 'pbk_scope_abcdefgh', name: 'diagnose', description: 'Diagnose service', status: 'active' },
    ]);
    expect(backend.fetch).toHaveBeenCalledTimes(1);
  });

  test('loads detail source directly', async () => {
    const backend = fakeBackend([{ id: 'pbk_scope_abcdefgh', name: 'diagnose', description: 'Diagnose service', status: 'active', source }]);
    const gateway = createResourcePlaybookCrudGateway({ backendSrv: backend });
    await expect(gateway.getPlaybook('pbk_scope_abcdefgh')).resolves.toMatchObject({ source });
    expect((backend.fetch as jest.Mock).mock.calls[0][0]).toMatchObject({ url: expect.stringContaining('/pbk_scope_abcdefgh') });
  });

  test('uses the operation idempotency key supplied by the editor', async () => {
    const backend = fakeBackend([{ id: 'pbk_scope_abcdefgh', name: 'diagnose', description: 'Diagnose service', status: 'active', source }]);
    const gateway = createResourcePlaybookCrudGateway({ backendSrv: backend });
    await gateway.createPlaybook({ source, idempotencyKey: 'playbook-operation-123' });
    expect((backend.fetch as jest.Mock).mock.calls[0][0]).toEqual(expect.objectContaining({
      method: 'POST', data: source,
      headers: { 'Content-Type': 'application/yaml', 'Idempotency-Key': 'playbook-operation-123' },
    }));
  });

  test('validates unsaved YAML and forwards update and delete', async () => {
    const backend = fakeBackend([
      { valid: true, errors: [] },
      { id: 'pbk_scope_abcdefgh', name: 'diagnose', description: 'Diagnose service', status: 'active', source },
      undefined,
    ]);
    const gateway = createResourcePlaybookCrudGateway({ backendSrv: backend });
    await expect(gateway.validatePlaybook(source)).resolves.toEqual({ valid: true, errors: [] });
    await gateway.updatePlaybook('pbk_scope_abcdefgh', { source });
    await gateway.deletePlaybook('pbk_scope_abcdefgh');
    const requests = (backend.fetch as jest.Mock).mock.calls.map(([request]) => request as BackendSrvRequest);
    expect(requests.map(({ method }) => method)).toEqual(['POST', 'PUT', 'DELETE']);
    expect(requests[0].url).toContain('/playbooks/validate');
  });
});

function fakeBackend(values: unknown[]): BackendSrv {
  const queue = [...values];
  return { fetch: jest.fn(() => of(response(queue.shift()))) } as unknown as BackendSrv;
}

function response(data: unknown): FetchResponse<unknown> {
  return { data, status: 200, statusText: 'OK', ok: true, headers: new Headers(), redirected: false, type: 'basic', url: '', config: { url: '' } } as FetchResponse<unknown>;
}
