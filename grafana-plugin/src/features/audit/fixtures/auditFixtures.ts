import { AuditData, AuditEvent, AuditEventType } from '../model';

export const auditEventTypes: AuditEventType[] = [
  'session_created',
  'llm_call',
  'tool_call',
  'hitl_decision',
  'object_personal_created',
  'object_promote_requested',
  'object_promote_approved',
  'object_promote_rejected',
  'webhook_received',
  'playbook_run',
];

export function createAuditFixtureData(now: Date): AuditData {
  const at = (hours: number, minutes: number, seconds = 0, dayOffset = 0) => {
    const value = new Date(now);
    value.setHours(hours, minutes, seconds, 0);
    value.setDate(value.getDate() + dayOffset);
    return value.toISOString();
  };
  const event = (
    id: string,
    occurredAt: string,
    type: AuditEvent['type'],
    actor: string,
    target: string,
    detail: string,
    outcome: AuditEvent['outcome'],
    folderUid?: string
  ): AuditEvent => ({ id, occurredAt, type, actor, target, detail, outcome, folderUid });

  return {
    schemaVersion: 1,
    events: [
      event(
        'a-1',
        at(14, 32, 18),
        'hitl_decision',
        'alice',
        'grafana.update_dashboard (checkout-overview)',
        'Approved by alice',
        'ok',
        'payment'
      ),
      event(
        'a-2',
        at(14, 31, 42),
        'tool_call',
        'AI Agent',
        'grafana.query_prometheus',
        'expr=histogram_quantile(0.95, ...), duration=1240ms',
        'ok',
        'payment'
      ),
      event(
        'a-3',
        at(14, 30),
        'llm_call',
        'AI Agent',
        'claude-sonnet-4 (primary)',
        'tokens: 1240 in / 380 out, 6 tool rounds',
        'ok',
        'payment'
      ),
      event(
        'a-4',
        at(14, 24, 1),
        'webhook_received',
        'alertmanager',
        'CheckoutLatencyHigh (fp-a1b2c3)',
        'HMAC verified, idempotent (skipped: already in queue)',
        'ok',
        'payment'
      ),
      event(
        'a-5',
        at(13, 50, 12),
        'object_promote_approved',
        'admin',
        'playbook/pb-005 → shared (Payment)',
        'Approved by admin, comment: "步骤很完整"',
        'ok',
        'payment'
      ),
      event(
        'a-6',
        at(13, 42),
        'playbook_run',
        '后台告警分析',
        'pg-connection-pool-debug (run-9815)',
        'duration: 18s, steps: 6/6 ok',
        'ok',
        'payment'
      ),
      event(
        'a-7',
        at(11, 8, 24),
        'object_promote_rejected',
        'admin',
        'playbook/pb-007',
        'Rejected: "第 2 步和第 3 步顺序不合理"',
        'rejected',
        'search'
      ),
      event(
        'a-8',
        at(10, 30),
        'object_personal_created',
        'alice',
        'playbook/private-incident-2026-07-21',
        'Auto-generated from session s-002 (5 turns)',
        'ok'
      ),
      event(
        'a-9',
        at(9, 15, 32),
        'session_created',
        'alice',
        'session/s-002',
        'Forked from session s-001 (snapshot)',
        'ok'
      ),
      event(
        'a-10',
        at(16, 22, 0, -1),
        'llm_call',
        'AI Agent',
        'claude-sonnet-4 → failover → gpt-4o',
        'Primary returned 503, auto-switched to secondary',
        'ok'
      ),
    ],
  };
}
