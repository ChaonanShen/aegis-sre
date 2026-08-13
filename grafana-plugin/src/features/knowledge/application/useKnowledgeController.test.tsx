import { act, renderHook, waitFor } from '@testing-library/react';
import { Folder } from '../../../app/model';
import { createFixtureKnowledgeGateway } from '../adapters/fixtureKnowledgeGateway';
import { ImportTask, KnowledgeSnapshot, ServiceEntry, StartImportInput } from '../model';
import { KnowledgeGateway } from '../ports/KnowledgeGateway';
import { useKnowledgeController } from './useKnowledgeController';

const infra: Folder = { uid: 'infra', title: 'Infra', permission: 'View', serviceCount: 5 };
const payment: Folder = { uid: 'payment', title: 'Payment', permission: 'Edit', serviceCount: 8 };

describe('useKnowledgeController', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  test('does not let a stale folder request replace the latest snapshot', async () => {
    const first = deferred<KnowledgeSnapshot>();
    const second = deferred<KnowledgeSnapshot>();
    const base = createFixtureKnowledgeGateway({ latencyMs: 0 });
    const gateway: KnowledgeGateway = {
      ...base,
      getSnapshot: jest.fn((folderUid: string) => (folderUid === 'infra' ? first.promise : second.promise)),
    };
    const { result, rerender } = renderHook(({ folder }) => useKnowledgeController({ activeFolder: folder, gateway }), {
      initialProps: { folder: infra },
    });

    await waitFor(() => expect(gateway.getSnapshot).toHaveBeenCalledWith('infra', expect.any(AbortSignal)));
    rerender({ folder: payment });
    await waitFor(() => expect(gateway.getSnapshot).toHaveBeenCalledWith('payment', expect.any(AbortSignal)));

    await act(async () => second.resolve(emptySnapshot('payment')));
    await waitFor(() => expect(result.current.snapshot).toMatchObject({ data: { folderUid: 'payment' } }));
    await act(async () => first.resolve(emptySnapshot('infra')));

    expect(result.current.snapshot).toMatchObject({ data: { folderUid: 'payment' } });
  });

  test('exposes write capability from the active folder permission', async () => {
    const gateway = createFixtureKnowledgeGateway({ latencyMs: 0 });
    const { result, rerender } = renderHook(({ folder }) => useKnowledgeController({ activeFolder: folder, gateway }), {
      initialProps: { folder: infra },
    });

    expect(result.current.writable).toBe(false);
    rerender({ folder: payment });
    expect(result.current.writable).toBe(true);
    await waitFor(() => expect(result.current.snapshot).toMatchObject({ data: { folderUid: 'payment' } }));
  });

  test('keeps an import failure visible after the event stream completes', async () => {
    const base = createFixtureKnowledgeGateway({ latencyMs: 0 });
    const failedTask: ImportTask = {
      id: 'imp-failed',
      folderUid: 'payment',
      status: 'failed',
      progress: 100,
      files: 1,
      failed: 1,
      importedBy: 'alice',
      candidates: [],
      createdDocumentIds: [],
      startedAt: '2026-07-25T08:00:00.000Z',
      updatedAt: '2026-07-25T08:00:01.000Z',
    };
    const gateway: KnowledgeGateway = {
      ...base,
      startImport: async function* (_input: StartImportInput) {
        yield { type: 'task_failed', payload: { task: failedTask, message: '解析失败。' } };
      },
    };
    const { result } = renderHook(() => useKnowledgeController({ activeFolder: payment, gateway }));

    await waitFor(() => expect(result.current.snapshot).toMatchObject({ status: 'success' }));
    await act(async () => {
      await result.current.startImport({
        folderUid: 'payment',
        importedBy: 'alice',
        files: [],
      });
    });

    expect(result.current.mutation).toMatchObject({ status: 'error', error: new Error('解析失败。') });
  });

  test('surfaces a retry failure instead of silently completing', async () => {
    const base = createFixtureKnowledgeGateway({ latencyMs: 0 });
    const failedTask: ImportTask = {
      id: 'imp-retry-failed',
      folderUid: 'payment',
      status: 'failed',
      progress: 100,
      files: 1,
      failed: 1,
      importedBy: 'alice',
      candidates: [],
      createdDocumentIds: [],
      startedAt: '2026-07-25T08:00:00.000Z',
      updatedAt: '2026-07-25T08:00:01.000Z',
    };
    const gateway: KnowledgeGateway = {
      ...base,
      retryImport: async function* (_taskId: string, _signal: AbortSignal) {
        yield { type: 'task_failed', payload: { task: failedTask, message: '重试解析失败。' } };
      },
    };
    const { result } = renderHook(() => useKnowledgeController({ activeFolder: payment, gateway }));

    await waitFor(() => expect(result.current.snapshot).toMatchObject({ status: 'success' }));
    await act(async () => {
      await result.current.retryImport(failedTask.id);
    });

    expect(result.current.mutation).toMatchObject({ status: 'error', error: new Error('重试解析失败。') });
  });

  test('does not publish a mutation result after the active Folder changes', async () => {
    const created = deferred<ServiceEntry>();
    const base = createFixtureKnowledgeGateway({ latencyMs: 0 });
    const gateway: KnowledgeGateway = {
      ...base,
      getSnapshot: jest.fn((folderUid: string) => Promise.resolve(emptySnapshot(folderUid))),
      createService: jest.fn(() => created.promise),
    };
    const { result, rerender } = renderHook(({ folder }) => useKnowledgeController({ activeFolder: folder, gateway }), {
      initialProps: { folder: infra },
    });

    await waitFor(() => expect(result.current.snapshot).toMatchObject({ data: { folderUid: 'infra' } }));
    let pending!: Promise<ServiceEntry | undefined>;
    act(() => {
      pending = result.current.createService({
        folderUid: 'infra',
        name: 'checkout',
        displayName: 'Checkout',
        owner: 'platform',
        tier: 'standard',
        keyMetrics: [],
      });
    });
    rerender({ folder: payment });
    await waitFor(() => expect(result.current.mutation.status).toBe('idle'));
    await waitFor(() => expect(result.current.snapshot).toMatchObject({ data: { folderUid: 'payment' } }));

    await act(async () => {
      created.resolve({
        id: 'service-old',
        folderUid: 'infra',
        name: 'checkout',
        displayName: 'Checkout',
        owner: 'platform',
        tier: 'standard',
        keyMetrics: [],
        runbookCount: 0,
        playbookCount: 0,
        version: 1,
        createdAt: '2026-07-25T08:00:00.000Z',
        updatedAt: '2026-07-25T08:00:00.000Z',
      });
      await pending;
    });

    expect(result.current.mutation.status).not.toBe('success');
    expect(result.current.snapshot).toMatchObject({ data: { folderUid: 'payment' } });
  });

  test('keeps mutation loading until the post-write snapshot is refreshed', async () => {
    const refreshed = deferred<KnowledgeSnapshot>();
    const base = createFixtureKnowledgeGateway({ latencyMs: 0 });
    let snapshotCalls = 0;
    const gateway: KnowledgeGateway = {
      ...base,
      getSnapshot: jest.fn((folderUid: string) => {
        snapshotCalls += 1;
        return snapshotCalls === 1 ? Promise.resolve(emptySnapshot(folderUid)) : refreshed.promise;
      }),
      createService: jest.fn((input) => base.createService(input)),
    };
    const { result } = renderHook(() => useKnowledgeController({ activeFolder: payment, gateway }));

    await waitFor(() => expect(gateway.getSnapshot).toHaveBeenCalledTimes(1));
    let pending!: Promise<ServiceEntry | undefined>;
    act(() => {
      pending = result.current.createService({
        folderUid: 'payment',
        name: 'new-service',
        displayName: 'New Service',
        owner: 'platform',
        tier: 'standard',
        keyMetrics: [],
      });
    });

    await waitFor(() => expect(gateway.getSnapshot).toHaveBeenCalledTimes(2));
    expect(result.current.mutation.status).toBe('loading');

    await act(async () => {
      refreshed.resolve(emptySnapshot('payment'));
      await pending;
    });
    expect(result.current.mutation.status).toBe('success');
  });

  test('does not refresh or publish a mutation after unmount', async () => {
    const created = deferred<ServiceEntry>();
    const base = createFixtureKnowledgeGateway({ latencyMs: 0 });
    const gateway: KnowledgeGateway = {
      ...base,
      getSnapshot: jest.fn((folderUid: string) => Promise.resolve(emptySnapshot(folderUid))),
      createService: jest.fn(() => created.promise),
    };
    const { result, unmount } = renderHook(() => useKnowledgeController({ activeFolder: payment, gateway }));

    await waitFor(() => expect(result.current.snapshot).toMatchObject({ data: { folderUid: 'payment' } }));
    let pending!: Promise<ServiceEntry | undefined>;
    act(() => {
      pending = result.current.createService({
        folderUid: 'payment',
        name: 'checkout',
        displayName: 'Checkout',
        owner: 'platform',
        tier: 'standard',
        keyMetrics: [],
      });
    });
    unmount();

    await act(async () => {
      created.resolve(service('service-after-unmount'));
      await expect(pending).resolves.toBeUndefined();
    });

    expect(gateway.getSnapshot).toHaveBeenCalledTimes(1);
  });

  test('aborts and invalidates an import when unmounted', async () => {
    const release = deferred<void>();
    let importSignal: AbortSignal | undefined;
    const base = createFixtureKnowledgeGateway({ latencyMs: 0 });
    const gateway: KnowledgeGateway = {
      ...base,
      startImport: async function* (_input: StartImportInput, signal: AbortSignal) {
        importSignal = signal;
        await release.promise;
        yield {
          type: 'task_updated',
          payload: {
            id: 'imp-after-unmount',
            folderUid: 'payment',
            status: 'parsing',
            progress: 50,
            files: 1,
            failed: 0,
            importedBy: 'alice',
            candidates: [],
            createdDocumentIds: [],
            startedAt: '2026-07-25T08:00:00.000Z',
            updatedAt: '2026-07-25T08:00:01.000Z',
          },
        };
      },
    };
    const { result, unmount } = renderHook(() => useKnowledgeController({ activeFolder: payment, gateway }));

    await waitFor(() => expect(result.current.snapshot).toMatchObject({ data: { folderUid: 'payment' } }));
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.startImport({ folderUid: 'payment', importedBy: 'alice', files: [] });
    });
    await waitFor(() => expect(importSignal).toBeDefined());

    unmount();
    expect(importSignal?.aborted).toBe(true);
    await act(async () => {
      release.resolve();
      await pending;
    });
  });
});

function emptySnapshot(folderUid: string): KnowledgeSnapshot {
  return {
    folderUid,
    services: [],
    runbooks: [],
    documents: [],
    imports: [],
    counts: { services: 0, runbooks: 0, documents: 0, imports: 0 },
  };
}

function service(id: string): ServiceEntry {
  return {
    id,
    folderUid: 'payment',
    name: 'checkout',
    displayName: 'Checkout',
    owner: 'platform',
    tier: 'standard',
    keyMetrics: [],
    runbookCount: 0,
    playbookCount: 0,
    version: 1,
    createdAt: '2026-07-25T08:00:00.000Z',
    updatedAt: '2026-07-25T08:00:00.000Z',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
