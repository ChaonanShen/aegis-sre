import { createAuditFixtureData } from '../features/audit/fixtures/auditFixtures';
import { AuditData, AuditEvent } from '../features/audit/model';

export const AUDIT_FIXTURE_STORAGE_KEY = 'torchbearing.fixture.audit.v1';

export type FixtureStorage = Pick<Storage, 'getItem' | 'setItem'>;

export interface AuditEventSink {
  append(event: AuditEvent): void;
}

export interface FixtureAuditStore extends AuditEventSink {
  read(): AuditData;
}

export interface FixtureAuditStoreOptions {
  storage?: FixtureStorage;
  storageKey?: string;
  now?: () => Date;
}

export function createFixtureAuditStore(options: FixtureAuditStoreOptions = {}): FixtureAuditStore {
  const storage = options.storage ?? window.sessionStorage;
  const storageKey = options.storageKey ?? AUDIT_FIXTURE_STORAGE_KEY;
  const now = options.now ?? (() => new Date());

  return {
    read() {
      return clone(readOrSeed(storage, storageKey, now));
    },
    append(event) {
      const data = readOrSeed(storage, storageKey, now);
      if (data.events.some(({ id }) => id === event.id)) {
        return;
      }
      data.events.push(clone(event));
      storage.setItem(storageKey, JSON.stringify(data));
    },
  };
}

function readOrSeed(storage: FixtureStorage, storageKey: string, now: () => Date): AuditData {
  try {
    const raw = storage.getItem(storageKey);
    if (raw) {
      const parsed = JSON.parse(raw) as AuditData;
      if (parsed.schemaVersion === 1 && Array.isArray(parsed.events)) {
        return parsed;
      }
    }
  } catch {
    // Re-seed malformed Fixture state below.
  }
  const seeded = createAuditFixtureData(now());
  storage.setItem(storageKey, JSON.stringify(seeded));
  return seeded;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
