import { createFixtureAuditStore } from '../../../fixtures/fixtureAuditStore';
import { createFixtureAuditGateway } from './fixtureAuditGateway';

describe('createFixtureAuditGateway', () => {
  const now = () => new Date('2026-07-25T08:00:00.000Z');

  test('combines search, type, actor, outcome, and time filters', async () => {
    const gateway = createFixtureAuditGateway({ storage: memoryStorage(), latencyMs: 0, now });
    expect(
      (await gateway.queryAudit({ search: 'prometheus', type: 'tool_call', outcome: 'ok', timeRange: 'today' })).events
    ).toHaveLength(1);
    expect((await gateway.queryAudit({ actor: 'AI Agent', timeRange: 'today' })).events).toHaveLength(2);
    expect((await gateway.queryAudit({ timeRange: '7d' })).summary.todayEvents).toBe(1247);
  });

  test('includes dynamically appended events and sorts newest first', async () => {
    const storage = memoryStorage();
    createFixtureAuditStore({ storage, now }).append({
      id: 'new',
      occurredAt: '2026-07-25T23:00:00.000Z',
      type: 'playbook_run',
      actor: 'alice',
      target: 'pb,test',
      detail: 'quoted "detail"',
      outcome: 'ok',
    });
    const result = await createFixtureAuditGateway({ storage, latencyMs: 0, now }).queryAudit({});
    expect(result.events[0].id).toBe('new');
  });

  test('exports filtered UTF-8 CSV with quoting and formula hardening', async () => {
    const storage = memoryStorage();
    createFixtureAuditStore({ storage, now }).append({
      id: 'csv',
      occurredAt: '2026-07-25T09:00:00.000Z',
      type: 'tool_call',
      actor: '=cmd',
      target: 'value,with,comma',
      detail: 'say "hi"',
      outcome: 'err',
    });
    const file = await createFixtureAuditGateway({ storage, latencyMs: 0, now }).exportAudit({ outcome: 'err' });
    expect(file).toMatchObject({ fileName: 'audit-2026-07-25.csv', rowCount: 1 });
    expect(file.content).toContain('"\'=cmd"');
    expect(file.content).toContain('"value,with,comma"');
    expect(file.content).toContain('"say ""hi"""');
  });

  test('honors AbortSignal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(createFixtureAuditGateway({ latencyMs: 10 }).queryAudit({}, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
