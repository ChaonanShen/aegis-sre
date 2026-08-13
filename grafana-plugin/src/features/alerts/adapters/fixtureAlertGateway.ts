import { createAuditFixtureData } from '../../audit/fixtures/auditFixtures';
import { AuditData, AuditEvent } from '../../audit/model';
import { AUDIT_FIXTURE_STORAGE_KEY, FixtureStorage } from '../../../fixtures/fixtureAuditStore';
import { createAlertFixtureData, pipeline } from '../fixtures/alertFixtures';
import { AlertData, AlertDetail, AlertQuery } from '../model';
import { AlertGateway } from '../ports/AlertGateway';

export const ALERT_FIXTURE_STORAGE_KEY = 'torchbearing.fixture.alerts.v1';

export interface FixtureAlertGatewayOptions {
  storage?: FixtureStorage;
  storageKey?: string;
  auditStorageKey?: string;
  latencyMs?: number;
  now?: () => Date;
  newId?: (prefix: string) => string;
}

export function createFixtureAlertGateway(options: FixtureAlertGatewayOptions = {}): AlertGateway {
  const storage = options.storage ?? window.sessionStorage;
  const storageKey = options.storageKey ?? ALERT_FIXTURE_STORAGE_KEY;
  const auditKey = options.auditStorageKey ?? AUDIT_FIXTURE_STORAGE_KEY;
  const latencyMs = options.latencyMs ?? 80;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? ((prefix: string) => `${prefix}-${Date.now()}`);
  const read = () => readOrSeed(storage, storageKey, createAlertFixtureData, validAlerts);

  return {
    async listAlerts(query, signal) {
      await delay(latencyMs, signal);
      const all = read().alerts;
      const since = now().getTime() - 86400000;
      return {
        alerts: clone(all.filter((item) => matches(item, query))).sort((a, b) =>
          b.startedAt.localeCompare(a.startedAt)
        ),
        summary: {
          firing: all.filter(({ status }) => status === 'firing').length,
          analyzing: all.filter(({ status }) => status === 'analyzing').length,
          analyzed24h: all.filter(({ status, startedAt }) => status === 'analyzed' && Date.parse(startedAt) >= since)
            .length,
          failed: all.filter(({ status }) => status === 'failed').length,
        },
      };
    },
    async getAlert(id, signal) {
      await delay(latencyMs, signal);
      const item = read().alerts.find((alert) => alert.id === id);
      if (!item) {
        throw new Error(`Alert "${id}" 不存在。`);
      }
      return clone(item);
    },
    async refreshAlerts(signal) {
      await delay(latencyMs, signal);
      const data = read();
      const changedIds: string[] = [];
      const timestamp = now().toISOString();
      for (const alert of data.alerts) {
        if (alert.status === 'firing') {
          alert.status = 'analyzing';
          alert.runId = `run-${alert.id.slice(3)}-fixture`;
          alert.pipeline = pipeline('analyzing');
          changedIds.push(alert.id);
        } else if (alert.status === 'analyzing') {
          alert.status = 'analyzed';
          alert.aiAnalysis = `${alert.service} 的关键指标与日志存在关联异常。建议先验证依赖容量，再运行推荐 Playbook。`;
          alert.recommendedPlaybookId = alert.folderUid === 'search' ? 'pb-003' : 'pb-001';
          alert.recommendedPlaybookName =
            alert.folderUid === 'search' ? 'search-qps-diagnosis' : 'checkout-latency-investigation';
          alert.pipeline = pipeline('analyzed');
          changedIds.push(alert.id);
        }
      }
      if (!changedIds.length) {
        return { alerts: clone(data.alerts), changedIds };
      }

      const audit = readOrSeed(storage, auditKey, () => createAuditFixtureData(now()), validAudit);
      const rawAlerts = storage.getItem(storageKey) as string;
      const rawAudit = storage.getItem(auditKey) as string;
      changedIds.forEach((id) => {
        const alert = data.alerts.find((item) => item.id === id) as AlertDetail;
        const event: AuditEvent = {
          id: newId('audit-alert'),
          occurredAt: timestamp,
          type: alert.status === 'analyzing' ? 'webhook_received' : 'playbook_run',
          actor: alert.status === 'analyzing' ? alert.source : '后台告警分析',
          target: `${alert.alertName} (${alert.id})`,
          detail: `Alert advanced to ${alert.status}`,
          outcome: alert.status === 'analyzing' ? 'pending' : 'ok',
          folderUid: alert.folderUid,
        };
        if (!audit.events.some(({ id: eventId }) => eventId === event.id)) {
          audit.events.push(event);
        }
      });
      try {
        storage.setItem(storageKey, JSON.stringify(data));
        storage.setItem(auditKey, JSON.stringify(audit));
      } catch (error) {
        try {
          storage.setItem(storageKey, rawAlerts);
          storage.setItem(auditKey, rawAudit);
        } catch {
          /* best effort */
        }
        throw error;
      }
      return { alerts: clone(data.alerts), changedIds };
    },
  };
}

function matches(item: AlertDetail, query: AlertQuery) {
  return (
    (!query.status || item.status === query.status) &&
    (!query.severity || item.severity === query.severity) &&
    (!query.folderUid || item.folderUid === query.folderUid)
  );
}
function readOrSeed<T>(storage: FixtureStorage, key: string, seed: () => T, valid: (value: T) => boolean): T {
  try {
    const raw = storage.getItem(key);
    if (raw) {
      const value = JSON.parse(raw) as T;
      if (valid(value)) {
        return value;
      }
    }
  } catch {
    /* seed below */
  }
  const value = seed();
  storage.setItem(key, JSON.stringify(value));
  return value;
}
const validAlerts = (value: AlertData) => value?.schemaVersion === 1 && Array.isArray(value.alerts);
const validAudit = (value: AuditData) => value?.schemaVersion === 1 && Array.isArray(value.events);
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
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
