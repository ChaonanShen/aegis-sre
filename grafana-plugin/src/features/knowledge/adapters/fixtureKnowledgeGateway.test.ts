import { KnowledgePermissionError, KnowledgeVersionConflictError } from '../errors';
import { createFixtureKnowledgeGateway } from './fixtureKnowledgeGateway';

describe('createFixtureKnowledgeGateway', () => {
  test('strictly filters every resource by folder', async () => {
    const gateway = createGateway();

    const payment = await gateway.getSnapshot('payment');
    const infra = await gateway.getSnapshot('infra');

    expect(payment.services.map(({ name }) => name)).toEqual(['checkout-api', 'payment-service', 'order-service']);
    expect(payment.runbooks).toHaveLength(1);
    expect(infra.services.map(({ name }) => name)).toEqual(['postgres', 'kafka']);
    expect(infra.documents).toHaveLength(1);
  });

  test('creates, updates, persists, and deletes a service', async () => {
    const storage = memoryStorage();
    const gateway = createGateway({ storage, newId: () => 'svc-new' });
    const created = await gateway.createService({
      folderUid: 'payment',
      name: 'fraud-api',
      displayName: 'Fraud API',
      owner: 'risk-team',
      tier: 'critical',
      keyMetrics: [],
    });
    expect(created).toMatchObject({ id: 'svc-new', version: 1 });

    const updated = await gateway.updateService(
      created.id,
      { ...created, displayName: 'Fraud Detection API' },
      created.version
    );
    expect(updated).toMatchObject({ displayName: 'Fraud Detection API', version: 2 });
    expect((await createGateway({ storage }).getSnapshot('payment')).services[0].displayName).toBe(
      'Fraud Detection API'
    );

    await gateway.deleteService(updated.id, updated.version);
    expect((await gateway.getSnapshot('payment')).services.some(({ id }) => id === updated.id)).toBe(false);
  });

  test('enforces folder permission and optimistic versions', async () => {
    const gateway = createGateway();
    await expect(
      gateway.createService({
        folderUid: 'infra',
        name: 'readonly',
        displayName: 'Readonly',
        owner: 'sre',
        tier: 'standard',
        keyMetrics: [],
      })
    ).rejects.toBeInstanceOf(KnowledgePermissionError);

    const service = (await gateway.getSnapshot('payment')).services[0];
    await expect(
      gateway.updateService(
        service.id,
        {
          name: service.name,
          displayName: service.displayName,
          owner: service.owner,
          tier: service.tier,
          keyMetrics: service.keyMetrics,
        },
        999
      )
    ).rejects.toBeInstanceOf(KnowledgeVersionConflictError);
  });

  test('records runbook history and keeps service counts in sync', async () => {
    const gateway = createGateway();
    const runbook = (await gateway.getSnapshot('payment')).runbooks[0];
    const updated = await gateway.updateRunbook(
      runbook.id,
      {
        title: `${runbook.title} v2`,
        serviceId: runbook.serviceId,
        tags: runbook.tags,
        severity: runbook.severity,
        author: 'alice',
        source: runbook.source,
        excerpt: runbook.excerpt,
        body: `${runbook.body}\n\n新增步骤`,
      },
      runbook.version
    );

    expect(updated.version).toBe(2);
    expect(updated.history[0]).toMatchObject({ version: 1, title: runbook.title });
    expect((await gateway.getSnapshot('payment')).services[0].runbookCount).toBe(1);
  });

  test('streams import progress and materializes successful documents', async () => {
    const gateway = createGateway({ newId: (prefix) => `${prefix}-new` });
    const events = await collect(
      gateway.startImport(
        {
          folderUid: 'payment',
          importedBy: 'alice',
          files: [
            { id: 'file-ok', name: 'guide.md', format: 'md', sizeBytes: 100, preview: '# Guide' },
            { id: 'file-bad', name: 'broken.pdf', format: 'pdf', sizeBytes: 200, preview: 'broken' },
          ],
        },
        new AbortController().signal
      )
    );
    const finalEvent = events.at(-1);
    expect(finalEvent?.type).toBe('task_updated');
    if (!finalEvent || finalEvent.type !== 'task_updated') {
      throw new Error('Expected the import to reach reviewing.');
    }
    const reviewing = finalEvent.payload;
    expect(reviewing).toMatchObject({ status: 'reviewing', progress: 80, failed: 1 });

    const result = await gateway.confirmImport({
      taskId: reviewing.id,
      skipFailures: true,
      candidates: reviewing.candidates,
    });
    expect(result.task.status).toBe('done');
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].name).toBe('guide.md');
  });

  test('updates and deletes document metadata with optimistic versions', async () => {
    const gateway = createGateway();
    const document = (await gateway.getSnapshot('payment')).documents[0];

    const updated = await gateway.updateDocument(
      document.id,
      {
        name: 'checkout-p95-guide.pdf',
        tags: ['latency', 'reviewed'],
        serviceId: 'svc-001',
        importedBy: 'alice',
      },
      document.version
    );
    expect(updated).toMatchObject({ name: 'checkout-p95-guide.pdf', version: 2, serviceId: 'svc-001' });

    await gateway.deleteDocument(updated.id, updated.version);
    expect((await gateway.getSnapshot('payment')).documents).toHaveLength(0);
  });

  test('aborts an import event stream', async () => {
    const gateway = createGateway({ importDelayMs: 20 });
    const controller = new AbortController();
    const iterator = gateway.startImport(
      {
        folderUid: 'payment',
        importedBy: 'alice',
        files: [{ id: 'file-1', name: 'guide.md', format: 'md', sizeBytes: 100, preview: '# Guide' }],
      },
      controller.signal
    )[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'task_updated' } });
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
  });

  test('recovers malformed persisted data', async () => {
    const storage = memoryStorage();
    storage.setItem('fixture', '{not json');
    const gateway = createGateway({ storage, storageKey: 'fixture' });

    await expect(gateway.getSnapshot('payment')).resolves.toMatchObject({ counts: { services: 3 } });
    expect(JSON.parse(storage.getItem('fixture') ?? '{}')).toMatchObject({ schemaVersion: 1 });
  });
});

function createGateway(overrides: Parameters<typeof createFixtureKnowledgeGateway>[0] = {}) {
  return createFixtureKnowledgeGateway({
    storage: memoryStorage(),
    latencyMs: 0,
    importDelayMs: 0,
    now: () => new Date('2026-07-25T06:00:00.000Z'),
    ...overrides,
  });
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
}

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}
