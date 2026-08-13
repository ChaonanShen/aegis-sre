import { AuditExportFile, AuditQuery, AuditQueryResult } from '../model';

export interface AuditGateway {
  queryAudit(query: AuditQuery, signal?: AbortSignal): Promise<AuditQueryResult>;
  exportAudit(query: AuditQuery, signal?: AbortSignal): Promise<AuditExportFile>;
}
