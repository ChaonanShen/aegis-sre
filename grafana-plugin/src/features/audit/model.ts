export type AuditEventType =
  | 'session_created'
  | 'llm_call'
  | 'tool_call'
  | 'hitl_decision'
  | 'object_personal_created'
  | 'object_promote_requested'
  | 'object_promote_approved'
  | 'object_promote_rejected'
  | 'webhook_received'
  | 'playbook_run';

export type AuditOutcome = 'ok' | 'rejected' | 'pending' | 'err';
export type AuditTimeRange = 'today' | '7d' | '30d' | 'all';

export interface AuditEvent {
  id: string;
  occurredAt: string;
  type: AuditEventType;
  actor: string;
  target: string;
  detail: string;
  outcome: AuditOutcome;
  folderUid?: string;
}

export interface AuditQuery {
  search?: string;
  type?: AuditEventType;
  actor?: string;
  outcome?: AuditOutcome;
  timeRange?: AuditTimeRange;
}

export interface AuditSummary {
  todayEvents: number;
  llmCalls: number;
  hitlDecisions: number;
  failovers: number;
}

export interface AuditRetention {
  fileName: string;
  retentionDays: number;
  coverage: AuditEventType[];
}

export interface AuditQueryResult {
  events: AuditEvent[];
  filteredCount: number;
  summary: AuditSummary;
  retention: AuditRetention;
}

export interface AuditExportFile {
  fileName: string;
  mimeType: 'text/csv;charset=utf-8';
  content: string;
  rowCount: number;
}

export interface AuditData {
  schemaVersion: 1;
  events: AuditEvent[];
}
