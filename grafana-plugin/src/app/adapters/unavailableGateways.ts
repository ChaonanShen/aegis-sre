import { AlertGateway } from '../../features/alerts/ports/AlertGateway';
import { ApprovalGateway } from '../../features/approvals/ports/ApprovalGateway';
import { AuditGateway } from '../../features/audit/ports/AuditGateway';
import { KnowledgeGateway } from '../../features/knowledge/ports/KnowledgeGateway';
import { SkillGateway } from '../../features/skills/ports/SkillGateway';
import { FolderGateway } from '../ports/FolderGateway';

export class CapabilityUnavailableError extends Error {
  readonly code = 'capability_unavailable';
  constructor(capability: string) {
    super(`${capability} 真实能力尚未接入。`);
    this.name = 'CapabilityUnavailableError';
  }
}

function unavailable<T extends object>(capability: string): T {
  return new Proxy({} as T, {
    get: () => async () => {
      throw new CapabilityUnavailableError(capability);
    },
  });
}

export const unavailableAlertGateway = unavailable<AlertGateway>('Grafana Alerts');
export const unavailableApprovalGateway = unavailable<ApprovalGateway>('Approvals');
export const unavailableAuditGateway = unavailable<AuditGateway>('跨 Provider Audit');
export const unavailableKnowledgeGateway = unavailable<KnowledgeGateway>('Knowledge / RAGFlow');
export const unavailableSkillGateway = unavailable<SkillGateway>('Agent Skills');
export const unavailableFolderGateway = unavailable<FolderGateway>('Grafana Folder');
