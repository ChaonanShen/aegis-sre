import { createFixtureAuditStore, FixtureAuditStoreOptions } from '../../../fixtures/fixtureAuditStore';
import { auditEventTypes } from '../fixtures/auditFixtures';
import { AuditEvent, AuditQuery } from '../model';
import { AuditGateway } from '../ports/AuditGateway';

export interface FixtureAuditGatewayOptions extends FixtureAuditStoreOptions {
  latencyMs?: number;
}

export function createFixtureAuditGateway(options: FixtureAuditGatewayOptions = {}): AuditGateway {
  const store = createFixtureAuditStore(options);
  const latencyMs = options.latencyMs ?? 80;
  const now = options.now ?? (() => new Date());
  const query = (input: AuditQuery) =>
    store
      .read()
      .events.filter((event) => matches(event, input, now()))
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

  return {
    async queryAudit(input, signal) {
      await delay(latencyMs, signal);
      const events = query(input);
      return {
        events,
        filteredCount: events.length,
        summary: { todayEvents: 1247, llmCalls: 342, hitlDecisions: 23, failovers: 2 },
        retention: { fileName: `audit-${datePart(now())}.log`, retentionDays: 30, coverage: auditEventTypes },
      };
    },
    async exportAudit(input, signal) {
      await delay(latencyMs, signal);
      const events = query(input);
      const header = ['time', 'type', 'Actor', 'Target', 'Detail', 'result'];
      const rows = events.map((event) => [
        event.occurredAt,
        event.type,
        event.actor,
        event.target,
        event.detail,
        event.outcome,
      ]);
      return {
        fileName: `audit-${datePart(now())}.csv`,
        mimeType: 'text/csv;charset=utf-8',
        content: `\uFEFF${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`,
        rowCount: events.length,
      };
    },
  };
}

function matches(event: AuditEvent, query: AuditQuery, now: Date) {
  const needle = query.search?.trim().toLocaleLowerCase();
  if (needle && !`${event.actor} ${event.target} ${event.detail}`.toLocaleLowerCase().includes(needle)) {
    return false;
  }
  if (query.type && event.type !== query.type) {
    return false;
  }
  if (query.actor && event.actor !== query.actor) {
    return false;
  }
  if (query.outcome && event.outcome !== query.outcome) {
    return false;
  }
  if (query.timeRange && query.timeRange !== 'all') {
    const start = new Date(now);
    if (query.timeRange === 'today') {
      start.setHours(0, 0, 0, 0);
    } else {
      start.setTime(now.getTime() - Number.parseInt(query.timeRange, 10) * 86400000);
    }
    if (Date.parse(event.occurredAt) < start.getTime()) {
      return false;
    }
  }
  return true;
}
function csvCell(value: string) {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}
function datePart(value: Date) {
  return value.toISOString().slice(0, 10);
}
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timer);
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      },
      { once: true }
    );
  });
}
