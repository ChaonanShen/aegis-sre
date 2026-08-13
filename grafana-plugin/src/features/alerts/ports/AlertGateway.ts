import { AlertDetail, AlertListResult, AlertQuery, AlertRefreshResult } from '../model';

export interface AlertGateway {
  listAlerts(query: AlertQuery, signal?: AbortSignal): Promise<AlertListResult>;
  getAlert(id: string, signal?: AbortSignal): Promise<AlertDetail>;
  refreshAlerts(signal?: AbortSignal): Promise<AlertRefreshResult>;
}
