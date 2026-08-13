import { stringify } from 'yaml';
import { playbookFixtureData } from '../../playbooks/fixtures/playbookFixtures';
import { Playbook } from '../../playbooks/model';
import { skillFixtureData } from '../../skills/fixtures/skillFixtures';
import { Skill } from '../../skills/model';
import { Approval, ApprovalData } from '../model';

export function createApprovalFixtureData(): ApprovalData {
  const playbook = (id: string) => playbookFixtureData.playbooks.find((item) => item.id === id) as Playbook;
  const skill = (id: string) => skillFixtureData.skills.find((item) => item.id === id) as Skill;
  const pbDraft = (id: string): Approval['draft'] => {
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
    } = playbook(id);
    return { objectType: 'playbook', definition, source: stringify(definition) };
  };
  const skDraft = (id: string): Approval['draft'] => {
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
    } = skill(id);
    return {
      objectType: 'skill',
      definition,
      source: `---\nname: ${definition.name}\ndescription: ${definition.description}\n---\n\n${definition.body}`,
    };
  };
  const base = (
    id: string,
    objectType: Approval['objectType'],
    objectId: string,
    requestedBy: string,
    targetFolderUid: string,
    targetFolderTitle: string,
    usageCount: number,
    createdAt: string
  ): Approval => ({
    id,
    objectType,
    objectId,
    objectTitle: objectType === 'playbook' ? playbook(objectId).name : skill(objectId).name,
    requestedBy,
    targetFolderUid,
    targetFolderTitle,
    usageCount,
    createdAt,
    status: 'pending',
    recordVersion: 1,
    draft: objectType === 'playbook' ? pbDraft(objectId) : skDraft(objectId),
  });

  const approved = base('apr-004', 'skill', 'sk-005', 'bob', 'infra', 'Infra', 15, '2026-07-18T08:00:00.000Z');
  Object.assign(approved, { status: 'approved', reviewerId: 'admin', reviewedAt: '2026-07-20T08:00:00.000Z' });
  const rejected = base('apr-005', 'playbook', 'pb-007', 'carol', 'search', 'Search', 3, '2026-07-18T09:00:00.000Z');
  Object.assign(rejected, {
    status: 'rejected',
    reviewerId: 'admin',
    reviewedAt: '2026-07-20T09:00:00.000Z',
    rejectReason: '第 2 步和第 3 步顺序不合理，应该先查下游再判断是否要 alert。',
  });

  return {
    schemaVersion: 1,
    approvals: [
      base('apr-001', 'playbook', 'pb-004', 'alice', 'payment', 'Payment', 2, '2026-07-25T06:00:00.000Z'),
      base('apr-002', 'skill', 'sk-004', 'alice', 'shared', 'Shared', 5, '2026-07-24T06:00:00.000Z'),
      base('apr-003', 'playbook', 'pb-006', 'dave', 'payment', 'Payment', 8, '2026-07-22T06:00:00.000Z'),
      base('apr-006', 'playbook', 'pb-008', 'dave', 'search', 'Search', 6, '2026-07-25T05:00:00.000Z'),
      approved,
      rejected,
    ],
  };
}
