import { fixtureFolderPermissions } from '../../../app/fixtures/folderFixtures';
import { FolderPermission } from '../../../app/model';
import { createAuditFixtureData } from '../../audit/fixtures/auditFixtures';
import { AuditData, AuditEvent } from '../../audit/model';
import { PLAYBOOK_FIXTURE_STORAGE_KEY } from '../../playbooks/adapters/fixturePlaybookGateway';
import { playbookFixtureData } from '../../playbooks/fixtures/playbookFixtures';
import { PlaybookData, PlaybookDefinition } from '../../playbooks/model';
import { SKILL_FIXTURE_STORAGE_KEY } from '../../skills/adapters/fixtureSkillGateway';
import { skillFixtureData } from '../../skills/fixtures/skillFixtures';
import { SkillData, SkillDefinition } from '../../skills/model';
import { AUDIT_FIXTURE_STORAGE_KEY, FixtureStorage } from '../../../fixtures/fixtureAuditStore';
import {
  ApprovalNotFoundError,
  ApprovalPermissionError,
  ApprovalValidationError,
  ApprovalVersionConflictError,
} from '../errors';
import { createApprovalFixtureData } from '../fixtures/approvalFixtures';
import { Approval, ApprovalData, ApprovalQuery } from '../model';
import { ApprovalGateway } from '../ports/ApprovalGateway';

export const APPROVAL_FIXTURE_STORAGE_KEY = 'torchbearing.fixture.approvals.v1';

export interface FixtureApprovalGatewayOptions {
  storage?: FixtureStorage;
  storageKey?: string;
  playbookStorageKey?: string;
  skillStorageKey?: string;
  auditStorageKey?: string;
  latencyMs?: number;
  now?: () => Date;
  currentUserId?: string;
  permissions?: Record<string, FolderPermission>;
  newId?: (prefix: string) => string;
}

export function createFixtureApprovalGateway(options: FixtureApprovalGatewayOptions = {}): ApprovalGateway {
  const storage = options.storage ?? window.sessionStorage;
  const storageKey = options.storageKey ?? APPROVAL_FIXTURE_STORAGE_KEY;
  const playbookKey = options.playbookStorageKey ?? PLAYBOOK_FIXTURE_STORAGE_KEY;
  const skillKey = options.skillStorageKey ?? SKILL_FIXTURE_STORAGE_KEY;
  const auditKey = options.auditStorageKey ?? AUDIT_FIXTURE_STORAGE_KEY;
  const latencyMs = options.latencyMs ?? 80;
  const now = options.now ?? (() => new Date());
  const currentUserId = options.currentUserId ?? 'alice';
  const permissions = options.permissions ?? fixtureFolderPermissions;
  const newId = options.newId ?? ((prefix: string) => `${prefix}-${Date.now()}`);

  const readApprovals = () => readOrSeed(storage, storageKey, createApprovalFixtureData, validApprovals);

  return {
    async listApprovals(query, signal) {
      await delay(latencyMs, signal);
      const all = readApprovals().approvals;
      return {
        approvals: clone(all.filter((item) => matches(item, query))).sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt)
        ),
        summary: summarize(all, now()),
      };
    },
    async getApproval(id, signal) {
      await delay(latencyMs, signal);
      return clone(findApproval(readApprovals(), id));
    },
    async approve(input, signal) {
      await delay(latencyMs, signal);
      return decide(input.id, input.expectedVersion, undefined);
    },
    async reject(input, signal) {
      await delay(latencyMs, signal);
      const reason = input.reason.trim();
      if (!reason) {
        throw new ApprovalValidationError('拒绝原因不能为空。');
      }
      return decide(input.id, input.expectedVersion, reason);
    },
  };

  function decide(id: string, expectedVersion: number, rejectReason?: string): Approval {
    const approvals = readApprovals();
    const approval = findApproval(approvals, id);
    if (approval.status !== 'pending') {
      throw new ApprovalValidationError('只有 pending 审批可以处理。');
    }
    if (approval.recordVersion !== expectedVersion) {
      throw new ApprovalVersionConflictError(id, expectedVersion, approval.recordVersion);
    }
    if (permissions[approval.targetFolderUid] !== 'Admin') {
      throw new ApprovalPermissionError();
    }

    const timestamp = now().toISOString();
    const originals = new Map<string, string>();
    const audit = readOrSeed(storage, auditKey, () => createAuditFixtureData(now()), validAudit);
    originals.set(storageKey, storage.getItem(storageKey) as string);
    originals.set(auditKey, storage.getItem(auditKey) as string);
    let resourceKey: string | undefined;
    let resourceValue: PlaybookData | SkillData | undefined;

    if (!rejectReason) {
      if (approval.objectType === 'playbook') {
        resourceKey = playbookKey;
        const data = readOrSeed(storage, playbookKey, () => clone(playbookFixtureData), validPlaybooks);
        const resource = data.playbooks.find(({ id: resourceId }) => resourceId === approval.objectId);
        if (!resource) {
          throw new ApprovalValidationError(`目标 Playbook "${approval.objectId}" 不存在。`);
        }
        if (resource.visibility !== 'private') {
          throw new ApprovalValidationError('目标 Playbook 已不是 private。');
        }
        const snapshot = playbookDefinition(resource);
        resource.visibility = 'shared';
        resource.folderUid = approval.targetFolderUid;
        resource.recordVersion += 1;
        resource.latestChangeNote = `Approval ${approval.id} 晋升至 ${approval.targetFolderTitle}`;
        resource.updatedAt = timestamp;
        resource.revisions.unshift({
          revision: resource.recordVersion,
          displayVersion: resource.version,
          author: currentUserId,
          savedAt: timestamp,
          changeNote: resource.latestChangeNote,
          snapshot: { ...snapshot, visibility: 'shared', folderUid: approval.targetFolderUid },
        });
        resourceValue = data;
      } else {
        resourceKey = skillKey;
        const data = readOrSeed(storage, skillKey, () => clone(skillFixtureData), validSkills);
        const resource = data.skills.find(({ id: resourceId }) => resourceId === approval.objectId);
        if (!resource) {
          throw new ApprovalValidationError(`目标 Skill "${approval.objectId}" 不存在。`);
        }
        if (resource.visibility !== 'private') {
          throw new ApprovalValidationError('目标 Skill 已不是 private。');
        }
        const snapshot = skillDefinition(resource);
        resource.visibility = 'shared';
        resource.folderUid = approval.targetFolderUid;
        resource.recordVersion += 1;
        resource.latestChangeNote = `Approval ${approval.id} 晋升至 ${approval.targetFolderTitle}`;
        resource.updatedAt = timestamp;
        resource.revisions.unshift({
          revision: resource.recordVersion,
          author: currentUserId,
          savedAt: timestamp,
          changeNote: resource.latestChangeNote,
          snapshot: { ...snapshot, visibility: 'shared', folderUid: approval.targetFolderUid },
        });
        resourceValue = data;
      }
      originals.set(resourceKey, storage.getItem(resourceKey) as string);
    }

    approval.status = rejectReason ? 'rejected' : 'approved';
    approval.reviewerId = currentUserId;
    approval.reviewedAt = timestamp;
    approval.rejectReason = rejectReason;
    approval.recordVersion += 1;
    const event: AuditEvent = {
      id: newId('audit'),
      occurredAt: timestamp,
      type: rejectReason ? 'object_promote_rejected' : 'object_promote_approved',
      actor: currentUserId,
      target: `${approval.objectType}/${approval.objectId}${rejectReason ? '' : ` → shared (${approval.targetFolderTitle})`}`,
      detail: rejectReason ? `Rejected: "${rejectReason}"` : `Approved by ${currentUserId}`,
      outcome: rejectReason ? 'rejected' : 'ok',
      folderUid: approval.targetFolderUid,
    };
    audit.events.push(event);

    try {
      if (resourceKey && resourceValue) {
        storage.setItem(resourceKey, JSON.stringify(resourceValue));
      }
      storage.setItem(storageKey, JSON.stringify(approvals));
      storage.setItem(auditKey, JSON.stringify(audit));
    } catch (error) {
      for (const [key, raw] of originals) {
        try {
          storage.setItem(key, raw);
        } catch {
          // Best-effort Fixture rollback; keep the original write error.
        }
      }
      throw error;
    }
    return clone(approval);
  }
}

function matches(item: Approval, query: ApprovalQuery): boolean {
  return (
    (!query.status || item.status === query.status) &&
    (!query.objectType || item.objectType === query.objectType) &&
    (!query.targetFolderUid || item.targetFolderUid === query.targetFolderUid)
  );
}

function summarize(items: Approval[], now: Date) {
  const since = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  const reviewed = items.filter(({ reviewedAt }) => reviewedAt && Date.parse(reviewedAt) >= since);
  const durations = reviewed.map(
    (item) => (Date.parse(item.reviewedAt as string) - Date.parse(item.createdAt)) / 3600000
  );
  return {
    pending: items.filter(({ status }) => status === 'pending').length,
    approved7d: reviewed.filter(({ status }) => status === 'approved').length,
    rejected7d: reviewed.filter(({ status }) => status === 'rejected').length,
    averageHandlingHours: durations.length
      ? Number((durations.reduce((a, b) => a + b, 0) / durations.length).toFixed(1))
      : 0,
    slaHours: 4,
  };
}

function findApproval(data: ApprovalData, id: string): Approval {
  const approval = data.approvals.find((item) => item.id === id);
  if (!approval) {
    throw new ApprovalNotFoundError(id);
  }
  return approval;
}

function readOrSeed<T>(storage: FixtureStorage, key: string, seed: () => T, valid: (value: T) => boolean): T {
  try {
    const raw = storage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as T;
      if (valid(parsed)) {
        return parsed;
      }
    }
  } catch {
    // Re-seed malformed Fixture state below.
  }
  const value = seed();
  storage.setItem(key, JSON.stringify(value));
  return value;
}

const validApprovals = (value: ApprovalData) => value?.schemaVersion === 1 && Array.isArray(value.approvals);
const validAudit = (value: AuditData) => value?.schemaVersion === 1 && Array.isArray(value.events);
const validPlaybooks = (value: PlaybookData) => value?.schemaVersion === 1 && Array.isArray(value.playbooks);
const validSkills = (value: SkillData) => value?.schemaVersion === 1 && Array.isArray(value.skills);

function playbookDefinition(value: PlaybookData['playbooks'][number]): PlaybookDefinition {
  const {
    id: _id,
    ownerId: _owner,
    usageCount: _usage,
    recordVersion: _record,
    revisions: _revisions,
    createdAt: _created,
    updatedAt: _updated,
    latestChangeNote: _note,
    ...definition
  } = value;
  return clone(definition);
}
function skillDefinition(value: SkillData['skills'][number]): SkillDefinition {
  const {
    id: _id,
    ownerId: _owner,
    usageCount: _usage,
    recordVersion: _record,
    revisions: _revisions,
    createdAt: _created,
    updatedAt: _updated,
    latestChangeNote: _note,
    ...definition
  } = value;
  return clone(definition);
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
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
