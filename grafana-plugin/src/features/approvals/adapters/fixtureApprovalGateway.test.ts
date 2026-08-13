import { PLAYBOOK_FIXTURE_STORAGE_KEY } from '../../playbooks/adapters/fixturePlaybookGateway';
import { PlaybookData } from '../../playbooks/model';
import { AUDIT_FIXTURE_STORAGE_KEY, createFixtureAuditStore } from '../../../fixtures/fixtureAuditStore';
import { ApprovalPermissionError, ApprovalValidationError, ApprovalVersionConflictError } from '../errors';
import { createFixtureApprovalGateway } from './fixtureApprovalGateway';

describe('createFixtureApprovalGateway', () => {
  const now = () => new Date('2026-07-25T08:00:00.000Z');

  test('filters approvals and computes summary from ISO timestamps', async () => {
    const gateway = createGateway();
    const result = await gateway.listApprovals({ status: 'pending', objectType: 'playbook' });
    expect(result.approvals.map(({ id }) => id)).toEqual(['apr-001', 'apr-006', 'apr-003']);
    expect(result.summary).toMatchObject({ pending: 4, slaHours: 4 });
  });

  test('requires target Folder Admin and validates reject reason', async () => {
    const gateway = createGateway();
    await expect(gateway.approve({ id: 'apr-001', expectedVersion: 1 })).rejects.toBeInstanceOf(
      ApprovalPermissionError
    );
    await expect(gateway.reject({ id: 'apr-006', expectedVersion: 1, reason: '  ' })).rejects.toBeInstanceOf(
      ApprovalValidationError
    );
  });

  test('promotes a private resource and appends one audit event', async () => {
    const storage = memoryStorage();
    const gateway = createGateway({ storage, newId: () => 'audit-approved' });
    const approved = await gateway.approve({ id: 'apr-006', expectedVersion: 1 });
    expect(approved).toMatchObject({ status: 'approved', reviewerId: 'alice', recordVersion: 2 });

    const playbooks = JSON.parse(storage.getItem(PLAYBOOK_FIXTURE_STORAGE_KEY) as string) as PlaybookData;
    expect(playbooks.playbooks.find(({ id }) => id === 'pb-008')).toMatchObject({
      visibility: 'shared',
      folderUid: 'search',
      recordVersion: 2,
      version: '0.1',
    });
    const audit = JSON.parse(storage.getItem(AUDIT_FIXTURE_STORAGE_KEY) as string);
    expect(audit.events.filter(({ id }: { id: string }) => id === 'audit-approved')).toHaveLength(1);
  });

  test('rejects without changing the target resource and records the reason', async () => {
    const storage = memoryStorage();
    const gateway = createGateway({ storage, newId: () => 'audit-rejected' });
    const before = await gateway.getApproval('apr-006');
    const rejected = await gateway.reject({
      id: before.id,
      expectedVersion: before.recordVersion,
      reason: '步骤缺少回滚说明',
    });
    expect(rejected).toMatchObject({ status: 'rejected', rejectReason: '步骤缺少回滚说明' });
    expect(storage.getItem(PLAYBOOK_FIXTURE_STORAGE_KEY)).toBeNull();
  });

  test('rejects stale and already-decided writes', async () => {
    const gateway = createGateway();
    await expect(gateway.approve({ id: 'apr-006', expectedVersion: 0 })).rejects.toBeInstanceOf(
      ApprovalVersionConflictError
    );
    await gateway.approve({ id: 'apr-006', expectedVersion: 1 });
    await expect(gateway.approve({ id: 'apr-006', expectedVersion: 2 })).rejects.toBeInstanceOf(
      ApprovalValidationError
    );
  });

  test('restores approval and resource state when the audit write fails', async () => {
    const base = memoryStorage();
    const gateway = createGateway({ storage: base });
    await gateway.getApproval('apr-006');
    createFixtureAuditStore({ storage: base, now }).read();
    const approvalsBefore = base.getItem('approvals');
    let failed = false;
    const failing = {
      getItem: base.getItem,
      setItem(key: string, value: string) {
        if (key === AUDIT_FIXTURE_STORAGE_KEY && !failed) {
          failed = true;
          throw new Error('quota');
        }
        base.setItem(key, value);
      },
    };
    await expect(createGateway({ storage: failing }).approve({ id: 'apr-006', expectedVersion: 1 })).rejects.toThrow(
      'quota'
    );
    expect(base.getItem('approvals')).toBe(approvalsBefore);
    const playbooks = JSON.parse(base.getItem(PLAYBOOK_FIXTURE_STORAGE_KEY) as string) as PlaybookData;
    expect(playbooks.playbooks.find(({ id }) => id === 'pb-008')?.visibility).toBe('private');
  });

  test('honors AbortSignal and recovers malformed approval storage', async () => {
    const storage = memoryStorage();
    storage.setItem('approvals', '{broken');
    expect((await createGateway({ storage }).listApprovals({})).approvals).toHaveLength(6);
    const controller = new AbortController();
    controller.abort();
    await expect(createGateway({ latencyMs: 10 }).listApprovals({}, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

function createGateway(overrides: Parameters<typeof createFixtureApprovalGateway>[0] = {}) {
  return createFixtureApprovalGateway({
    storageKey: 'approvals',
    latencyMs: 0,
    now: () => new Date('2026-07-25T08:00:00.000Z'),
    permissions: { payment: 'Edit', shared: 'View', infra: 'View', search: 'Admin' },
    ...overrides,
  });
}

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}
