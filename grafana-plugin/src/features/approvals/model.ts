import { PlaybookDefinition } from '../playbooks/model';
import { SkillDefinition } from '../skills/model';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';
export type ApprovalObjectType = 'playbook' | 'skill';

export type ApprovalDraft =
  | { objectType: 'playbook'; definition: PlaybookDefinition; source: string }
  | { objectType: 'skill'; definition: SkillDefinition; source: string };

export interface Approval {
  id: string;
  objectType: ApprovalObjectType;
  objectId: string;
  objectTitle: string;
  requestedBy: string;
  targetFolderUid: string;
  targetFolderTitle: string;
  usageCount: number;
  status: ApprovalStatus;
  draft: ApprovalDraft;
  reviewerId?: string;
  rejectReason?: string;
  createdAt: string;
  reviewedAt?: string;
  recordVersion: number;
}

export interface ApprovalQuery {
  status?: ApprovalStatus;
  objectType?: ApprovalObjectType;
  targetFolderUid?: string;
}

export interface ApprovalSummary {
  pending: number;
  approved7d: number;
  rejected7d: number;
  averageHandlingHours: number;
  slaHours: number;
}

export interface ApprovalListResult {
  approvals: Approval[];
  summary: ApprovalSummary;
}

export interface ApproveApprovalInput {
  id: string;
  expectedVersion: number;
}

export interface RejectApprovalInput extends ApproveApprovalInput {
  reason: string;
}

export interface ApprovalData {
  schemaVersion: 1;
  approvals: Approval[];
}
