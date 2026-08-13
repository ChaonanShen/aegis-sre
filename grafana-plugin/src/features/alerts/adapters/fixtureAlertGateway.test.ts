import { AUDIT_FIXTURE_STORAGE_KEY } from '../../../fixtures/fixtureAuditStore';
import { createFixtureAlertGateway } from './fixtureAlertGateway';

describe('createFixtureAlertGateway', () => {
  test('filters, summarizes, and returns adapter-owned pipeline data', async () => {
    const gateway = createGateway();
    const result = await gateway.listAlerts({ severity: 'warning' });
    expect(result.alerts).toHaveLength(3);
    expect(result.summary).toEqual({ firing: 1, analyzing: 1, analyzed24h: 1, failed: 1 });
    expect((await gateway.getAlert('al-001')).pipeline.map(({ state }) => state)).toContain('running');
  });

  test('deterministically advances active alerts and appends audit events', async () => {
    const storage = memoryStorage();
    let id = 0;
    const gateway = createGateway({ storage, newId: () => `audit-${++id}` });
    const first = await gateway.refreshAlerts();
    expect(first.changedIds).toEqual(['al-001', 'al-003']);
    expect((await gateway.getAlert('al-001')).status).toBe('analyzed');
    expect((await gateway.getAlert('al-003')).status).toBe('analyzing');
    const second = await gateway.refreshAlerts();
    expect(second.changedIds).toEqual(['al-003']);
    expect((await gateway.getAlert('al-003')).recommendedPlaybookId).toBe('pb-003');
    expect(JSON.parse(storage.getItem(AUDIT_FIXTURE_STORAGE_KEY) as string).events).toHaveLength(13);
    expect((await gateway.refreshAlerts()).changedIds).toEqual([]);
    expect(JSON.parse(storage.getItem(AUDIT_FIXTURE_STORAGE_KEY) as string).events).toHaveLength(13);
  });

  test('recovers malformed storage and honors AbortSignal', async () => {
    const storage = memoryStorage();
    storage.setItem('alerts', '{broken');
    expect((await createGateway({ storage }).listAlerts({})).alerts).toHaveLength(5);
    const controller = new AbortController();
    controller.abort();
    await expect(createGateway({ latencyMs: 10 }).listAlerts({}, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

function createGateway(options: Parameters<typeof createFixtureAlertGateway>[0] = {}) {
  return createFixtureAlertGateway({
    storageKey: 'alerts',
    latencyMs: 0,
    now: () => new Date('2026-07-25T08:00:00.000Z'),
    ...options,
  });
}
function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
