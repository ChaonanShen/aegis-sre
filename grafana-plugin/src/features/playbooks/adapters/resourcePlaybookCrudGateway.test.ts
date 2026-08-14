import { BackendSrv, BackendSrvRequest, FetchResponse } from '@grafana/runtime';
import { of } from 'rxjs';
import { createResourcePlaybookCrudGateway } from './resourcePlaybookCrudGateway';

const source = `name: diagnose
description: Diagnose service
steps: []
`;

const run = {
  id: 'run_abcdefgh',
  playbook_id: 'pbk_scope_abcdefgh',
  status: 'running',
  sequence: 1,
  started_at: '2026-08-14T10:00:00Z',
  updated_at: '2026-08-14T10:00:01Z',
  steps: [{ id: 'inspect', name: 'Inspect', status: 'running' }],
};

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

  test('does not impose the legacy steps projection on native Dagu YAML', async () => {
    const controllerSource = `name: controller\nhandler_on:\n  success:\n    command: echo done\n`;
    const backend = fakeBackend([
      { valid: true, errors: [] },
      { id: 'pbk_scope_abcdefgh', name: 'controller', description: '', status: 'active', source: controllerSource },
    ]);
    const gateway = createResourcePlaybookCrudGateway({ backendSrv: backend });
    await expect(gateway.validatePlaybook(controllerSource)).resolves.toEqual({ valid: true, errors: [] });
    await expect(gateway.getPlaybook('pbk_scope_abcdefgh')).resolves.toMatchObject({ source: controllerSource });
  });

  test('starts, polls, lists and cancels real Dagu runs', async () => {
    const backend = fakeBackend([{ ...run, status: 'queued' }, run, { items: [run], has_more: false }, undefined, { ...run, status: 'queued' }]);
    const gateway = createResourcePlaybookCrudGateway({ backendSrv: backend });

    await expect(
      gateway.startRun('pbk_scope_abcdefgh', { parameters: { service: 'api' }, idempotencyKey: 'run-operation-123' })
    ).resolves.toMatchObject({ id: 'run_abcdefgh', status: 'queued' });
    await expect(gateway.getRun('run_abcdefgh')).resolves.toMatchObject({ status: 'running', steps: [{ id: 'inspect' }] });
    await expect(gateway.listRuns('pbk_scope_abcdefgh')).resolves.toHaveLength(1);
    await gateway.cancelRun('run_abcdefgh');
    await expect(gateway.retryRun!('run_abcdefgh', 'retry-operation-123')).resolves.toMatchObject({ status: 'queued' });

    const requests = (backend.fetch as jest.Mock).mock.calls.map(([request]) => request as BackendSrvRequest);
    expect(requests).toEqual([
      expect.objectContaining({
        method: 'POST',
        data: { parameters: { service: 'api' } },
        headers: { 'Idempotency-Key': 'run-operation-123' },
        url: expect.stringContaining('/playbooks/pbk_scope_abcdefgh/runs'),
      }),
      expect.objectContaining({ method: 'GET', url: expect.stringContaining('/runs/run_abcdefgh') }),
      expect.objectContaining({ method: 'GET', url: expect.stringContaining('/playbooks/pbk_scope_abcdefgh/runs') }),
      expect.objectContaining({ method: 'POST', url: expect.stringContaining('/runs/run_abcdefgh:cancel') }),
      expect.objectContaining({ method: 'POST', headers: { 'Idempotency-Key': 'retry-operation-123' }, url: expect.stringContaining('/runs/run_abcdefgh:retry') }),
    ]);
  });

  test('completes human tasks, resolves approvals and projects artifacts', async () => {
    const backend = fakeBackend([
      undefined,
      undefined,
      { items: [{ name: 'report.md', path: 'reports/report.md', media_type: 'text/markdown', size: 12 }] },
      { name: 'report.md', path: 'reports/report.md', media_type: 'text/markdown', size: 12, text: 'done', truncated: false },
    ]);
    const gateway = createResourcePlaybookCrudGateway({ backendSrv: backend });
    await gateway.completeHumanTask!('run_abcdefgh', 'approve', { answer: 'yes' }, 'human-operation-123');
    await gateway.resolveApproval!('run_abcdefgh', 'approve', 'approve', { reason: 'ok' }, 'approval-operation-123');
    await expect(gateway.listArtifacts!('run_abcdefgh')).resolves.toEqual([{ name: 'report.md', path: 'reports/report.md', mediaType: 'text/markdown', size: 12 }]);
    await expect(gateway.previewArtifact!('run_abcdefgh', 'reports/report.md')).resolves.toMatchObject({ text: 'done', truncated: false });
    expect(gateway.artifactDownloadUrl!('run_abcdefgh', 'reports/report.md')).toContain('artifacts/download?path=reports%2Freport.md');
    const requests = (backend.fetch as jest.Mock).mock.calls.map(([request]) => request as BackendSrvRequest);
    expect(requests[0]).toEqual(expect.objectContaining({ method: 'POST', headers: { 'Idempotency-Key': 'human-operation-123' } }));
    expect(requests[1]).toEqual(expect.objectContaining({ method: 'POST', data: { decision: 'approve', inputs: { reason: 'ok' } } }));
  });
});

function fakeBackend(values: unknown[]): BackendSrv {
  const queue = [...values];
  return { fetch: jest.fn(() => of(response(queue.shift()))) } as unknown as BackendSrv;
}

function response(data: unknown): FetchResponse<unknown> {
  return { data, status: 200, statusText: 'OK', ok: true, headers: new Headers(), redirected: false, type: 'basic', url: '', config: { url: '' } } as FetchResponse<unknown>;
}
