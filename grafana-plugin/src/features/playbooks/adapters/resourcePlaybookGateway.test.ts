import { BackendSrv, BackendSrvRequest, FetchResponse } from '@grafana/runtime';
import { Observable, of } from 'rxjs';
import { createResourcePlaybookGateway } from './resourcePlaybookGateway';

const source = `name: diagnose
steps:
  - id: metrics
    action: mcp.call
    with: {server: grafana-read, tool: query_prometheus}
`;

describe('Control Plane Playbook gateway', () => {
  test('loads native Dagu YAML and projects it for the graph', async () => {
    const backend = fakeBackend([
      { items: [{ id: 'pbk_abcdefgh', name: 'diagnose', status: 'active' }], has_more: false },
      { id: 'pbk_abcdefgh', name: 'diagnose', status: 'active', source },
    ]);
    const gateway = createResourcePlaybookGateway({ backendSrv: backend });
    await expect(gateway.listPlaybooks({ folderUids: [] })).resolves.toEqual([
      expect.objectContaining({ id: 'pbk_abcdefgh', source, steps: [expect.objectContaining({ id: 'metrics', type: 'mcp_call' })] }),
    ]);
  });

  test('writes only native Dagu YAML with an idempotency key', async () => {
    const backend = fakeBackend([{ id: 'pbk_abcdefgh', name: 'diagnose', status: 'active', source }]);
    const gateway = createResourcePlaybookGateway({ backendSrv: backend });
    await gateway.createPlaybook({ ...definition(source), changeNote: 'create' });
    const request = (backend.fetch as jest.Mock).mock.calls[0][0] as BackendSrvRequest;
    expect(request).toEqual(expect.objectContaining({
      method: 'POST',
      data: source,
      headers: expect.objectContaining({ 'Content-Type': 'application/yaml', 'Idempotency-Key': expect.stringMatching(/^playbook-/) }),
    }));
  });

  test('loads run history from the Control Plane', async () => {
	const run = { id: 'run_abcdefgh', playbook_id: 'pbk_abcdefgh', status: 'succeeded', sequence: 1, started_at: '2026-08-13T00:00:00Z', updated_at: '2026-08-13T00:01:00Z' };
	const backend = fakeBackend([{ items: [run], has_more: false }]);
	const gateway = createResourcePlaybookGateway({ backendSrv: backend });
	await expect(gateway.listRuns('pbk_abcdefgh')).resolves.toEqual([expect.objectContaining({ id: 'run_abcdefgh', status: 'success' })]);
  });

  test('fails closed when the retired dry-run adapter is invoked', async () => {
    const backend = fakeBackend([]);
    const gateway = createResourcePlaybookGateway({ backendSrv: backend });
    const controller = new AbortController();
    const iterator = gateway.startDryRun({ playbookId: 'pbk_abcdefgh', params: {} }, controller.signal)[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ code: 'capability_unavailable' });
    expect(backend.fetch).not.toHaveBeenCalled();
    expect(backend.chunked).not.toHaveBeenCalled();
  });

  test('rejects legacy DSL before making a real request', async () => {
    const backend = fakeBackend([]);
    const gateway = createResourcePlaybookGateway({ backendSrv: backend });
    await expect(gateway.createPlaybook({ ...definition(undefined), changeNote: 'bad' })).rejects.toMatchObject({ code: 'invalid_argument' });
    expect(backend.fetch).not.toHaveBeenCalled();
  });
});

function definition(nativeSource?: string) {
  return {
    source: nativeSource,
    name: 'diagnose', description: '', version: 'dagu-native', trigger: { type: 'manual' as const, alertLabels: {} },
    parameters: [], steps: [], experience: [], visibility: 'private' as const,
  };
}

function fakeBackend(values: unknown[], stream: Observable<FetchResponse<Uint8Array | undefined>> = of()): BackendSrv {
  const queue = [...values];
  return {
    fetch: jest.fn(() => of(response(queue.shift()))),
    chunked: jest.fn(() => stream),
  } as unknown as BackendSrv;
}

function response(data: unknown, status = 200): FetchResponse<unknown> {
  return { data, status, statusText: 'OK', ok: true, headers: new Headers(), redirected: false, type: 'basic', url: '', config: { url: '' } } as FetchResponse<unknown>;
}
