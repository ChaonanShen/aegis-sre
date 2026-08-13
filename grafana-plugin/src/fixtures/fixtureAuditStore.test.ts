import { createFixtureAuditStore } from './fixtureAuditStore';

describe('createFixtureAuditStore', () => {
  test('seeds, persists, and de-duplicates appended events', () => {
    const storage = memoryStorage();
    const now = () => new Date('2026-07-25T08:00:00.000Z');
    const first = createFixtureAuditStore({ storage, now });
    expect(first.read().events).toHaveLength(10);

    const event = {
      id: 'dynamic-1',
      occurredAt: now().toISOString(),
      type: 'object_promote_approved' as const,
      actor: 'alice',
      target: 'playbook/pb-006',
      detail: 'Approved',
      outcome: 'ok' as const,
      folderUid: 'search',
    };
    first.append(event);
    first.append(event);

    expect(createFixtureAuditStore({ storage, now }).read().events).toHaveLength(11);
    expect(first.read().events.at(-1)).toEqual(event);
  });

  test('recovers malformed storage with ISO timestamps based on the injected clock', () => {
    const storage = memoryStorage();
    storage.setItem('audit', '{broken');
    const store = createFixtureAuditStore({
      storage,
      storageKey: 'audit',
      now: () => new Date('2026-07-25T08:00:00.000Z'),
    });

    expect(store.read().events).toHaveLength(10);
    expect(store.read().events.every(({ occurredAt }) => !Number.isNaN(Date.parse(occurredAt)))).toBe(true);
  });
});

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}
