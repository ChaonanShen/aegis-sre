export type AlertStatus = 'firing' | 'analyzing' | 'analyzed' | 'resolved' | 'failed';
export type AlertSeverity = 'critical' | 'warning' | 'info';
export type AlertPipelineState = 'pending' | 'running' | 'ok' | 'error';

export interface AlertPipelineStep {
  id: string;
  label: string;
  description: string;
  state: AlertPipelineState;
}

export interface AlertListItem {
  id: string;
  source: 'alertmanager' | 'grafana';
  fingerprint: string;
  status: AlertStatus;
  severity: AlertSeverity;
  alertName: string;
  service: string;
  folderUid: string;
  summary: string;
  startedAt: string;
  receivedAt: string;
}

export interface AlertDetail extends AlertListItem {
  runId?: string;
  aiAnalysis?: string;
  recommendedPlaybookId?: string;
  recommendedPlaybookName?: string;
  failureMessage?: string;
  retrySummary?: string;
  pipeline: AlertPipelineStep[];
}

export interface AlertQuery {
  status?: AlertStatus;
  severity?: AlertSeverity;
  folderUid?: string;
}

export interface AlertSummary {
  firing: number;
  analyzing: number;
  analyzed24h: number;
  failed: number;
}

export interface AlertListResult {
  alerts: AlertListItem[];
  summary: AlertSummary;
}

export interface AlertRefreshResult {
  alerts: AlertDetail[];
  changedIds: string[];
}

export interface AlertData {
  schemaVersion: 1;
  alerts: AlertDetail[];
}
