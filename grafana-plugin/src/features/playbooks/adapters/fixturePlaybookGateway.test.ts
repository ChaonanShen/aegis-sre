import {
  PlaybookPermissionError,
  PlaybookValidationError,
  PlaybookVersionConflictError,
} from '../errors';
import { Playbook, PlaybookDefinition, PlaybookRunEvent } from '../model';
import { createFixturePlaybookGateway } from './fixturePlaybookGateway';

describe('createFixturePlaybookGateway', () => {
  test('aggregates accessible shared playbooks and the current user private playbooks', async () => {
    const gateway = createGateway();
    const result = await gateway.listPlaybooks({ folderUids: ['payment', 'infra'] });

    expect(result.map(({ id }) => id)).toEqual(expect.arrayContaining(['pb-001', 'pb-002', 'pb-004', 'pb-005']));
    expect(result.map(({ id }) => id)).not.toContain('pb-003');
  });

  test('creates, persists, updates with a patch revision, and deletes a private playbook', async () => {
    const storage = memoryStorage();
    const gateway = createGateway({ storage, newId: () => 'pb-new' });
    const created = await gateway.createPlaybook({ ...validDefinition(), changeNote: '初始创建' });
    expect(created).toMatchObject({ id: 'pb-new', recordVersion: 1, version: '0.1' });

    const updated = await gateway.updatePlaybook(
      created.id,
      { ...validDefinition(), description: '更新后的说明', changeNote: '补充说明' },
      created.recordVersion
    );
    expect(updated).toMatchObject({ recordVersion: 2, version: '0.1.1', description: '更新后的说明' });
    expect(updated.revisions[0]).toMatchObject({ revision: 2, changeNote: '补充说明' });
    expect((await createGateway({ storage }).getPlaybook(created.id)).description).toBe('更新后的说明');

    await gateway.deletePlaybook(updated.id, updated.recordVersion);
    await expect(gateway.getPlaybook(updated.id)).rejects.toThrow(/不存在/);
  });

  test('enforces resource and target Folder permissions', async () => {
    const gateway = createGateway();
    const infra = await gateway.getPlaybook('pb-002');
    await expect(
      gateway.updatePlaybook(infra.id, { ...copyDefinition(infra), changeNote: '尝试修改' }, infra.recordVersion)
    ).rejects.toBeInstanceOf(PlaybookPermissionError);
    await expect(
      gateway.createPlaybook({
        ...validDefinition(),
        visibility: 'shared',
        folderUid: 'infra',
        changeNote: '尝试共享',
      })
    ).rejects.toBeInstanceOf(PlaybookPermissionError);
  });

  test('rejects stale versions and duplicate names', async () => {
    const gateway = createGateway();
    const current = await gateway.getPlaybook('pb-001');
    await expect(
      gateway.updatePlaybook(
        current.id,
        { ...copyDefinition(current), changeNote: '过期写入' },
        current.recordVersion - 1
      )
    ).rejects.toBeInstanceOf(PlaybookVersionConflictError);
    await expect(
      gateway.createPlaybook({
        ...validDefinition(),
        name: 'checkout-latency-investigation',
        changeNote: '重复',
      })
    ).rejects.toBeInstanceOf(PlaybookValidationError);
  });

  test('validates missing dependencies and cycles', async () => {
    const gateway = createGateway();
    await expect(
      gateway.createPlaybook({
        ...validDefinition(),
        steps: [{ ...validDefinition().steps[0], dependsOn: ['missing'] }],
        changeNote: '无效依赖',
      })
    ).rejects.toThrow(/无效依赖/);

    const a = { ...validDefinition().steps[0], id: 'a', dependsOn: ['b'] };
    const b = { ...validDefinition().steps[0], id: 'b', dependsOn: ['a'] };
    await expect(
      gateway.createPlaybook({ ...validDefinition(), steps: [a, b], changeNote: '环' })
    ).rejects.toThrow(/形成环/);
  });

  test('persists a private draft generated from a Workbench session', async () => {
    const storage = memoryStorage();
    const gateway = createGateway({ storage, newId: () => 'draft-new' });
    const draft = await gateway.generateDraft({
      sessionId: 's-001',
      sessionTitle: 'Checkout latency review',
      folderUid: 'payment',
    });
    expect(draft).toMatchObject({
      id: 'draft-new',
      visibility: 'private',
      sourceSessionId: 's-001',
      name: 'checkout-latency-review-investigation',
    });
    expect((await createGateway({ storage }).getDraft(draft.id)).steps).toHaveLength(2);
    await gateway.discardDraft(draft.id);
    await expect(gateway.getDraft(draft.id)).rejects.toThrow(/不存在/);
  });

  test('recovers malformed persisted state', async () => {
    const storage = memoryStorage();
    storage.setItem('fixture', '{broken');
    const gateway = createGateway({ storage, storageKey: 'fixture' });
    expect(await gateway.listPlaybooks({ folderUids: ['payment'] })).toHaveLength(3);
  });

  test('streams a dry run through HITL and persists the successful result', async () => {
    const gateway = createGateway({ newId: (prefix) => `${prefix}-new`, streamDelayMs: 0 });
    const events = await collect(
      gateway.startDryRun({ playbookId: 'pb-001', params: { env: 'production' } }, new AbortController().signal)
    );
    const waiting = eventRun(events.at(-1));
    expect(waiting).toMatchObject({ id: 'run-new', status: 'waiting_for_approval' });
    expect(waiting.pendingInterrupt).toMatchObject({ stepId: 'check_downstream', tool: 'query_tempo' });

    const resolved = await collect(
      gateway.resolveRun({ runId: waiting.id, decision: 'approved' }, new AbortController().signal)
    );
    expect(eventRun(resolved.at(-1)).status).toBe('success');
    expect((await gateway.getPlaybook('pb-001')).usageCount).toBe(28);
  });

  test('allows View users to run and skip but not approve a side effect', async () => {
    const gateway = createGateway({
      permissions: { payment: 'View' },
      newId: () => 'run-view',
      streamDelayMs: 0,
    });
    const waiting = eventRun(
      (
        await collect(
          gateway.startDryRun({ playbookId: 'pb-001', params: { env: 'production' } }, new AbortController().signal)
        )
      ).at(-1)
    );
    await expect(
      collect(gateway.resolveRun({ runId: waiting.id, decision: 'approved' }, new AbortController().signal))
    ).rejects.toBeInstanceOf(PlaybookPermissionError);
    const skipped = await collect(
      gateway.resolveRun({ runId: waiting.id, decision: 'skipped' }, new AbortController().signal)
    );
    expect(eventRun(skipped.at(-1)).status).toBe('success');
  });

  test('cancels a running fixture run', async () => {
    const gateway = createGateway({ newId: () => 'run-cancel', streamDelayMs: 20 });
    const stream = gateway.startDryRun(
      { playbookId: 'pb-001', params: { env: 'production' } },
      new AbortController().signal
    )[Symbol.asyncIterator]();
    expect(eventRun((await stream.next()).value).status).toBe('running');
    expect(await gateway.cancelRun('run-cancel')).toMatchObject({ status: 'cancelled' });
  });

  test('creates a new successful attempt when retrying a fail-once run', async () => {
    let sequence = 0;
    const gateway = createGateway({
      newId: (prefix) => `${prefix}-${++sequence}`,
      streamDelayMs: 0,
    });
    const created = await gateway.createPlaybook({
      ...validDefinition(),
      steps: [
        {
          ...validDefinition().steps[0],
          config: { dialect: 'promql', expr: 'up', fixture_outcome: 'fail_once' },
        },
      ],
      changeNote: '失败重试 Fixture',
    });
    const failedEvents = await collect(
      gateway.startDryRun({ playbookId: created.id, params: {} }, new AbortController().signal)
    );
    const failed = eventRun(failedEvents.at(-1));
    expect(failed.status).toBe('failed');

    const retried = await collect(gateway.retryRun(failed.id, new AbortController().signal));
    expect(eventRun(retried.at(-1))).toMatchObject({ status: 'success', retryOf: failed.id });
  });
});

function validDefinition(): PlaybookDefinition {
  return {
    name: 'new-investigation',
    description: '新的排查流程',
    version: '0.1',
    trigger: { type: 'manual', alertLabels: {} },
    parameters: [],
    steps: [
      {
        id: 'query_metrics',
        type: 'query',
        label: '查询指标',
        dependsOn: [],
        config: { dialect: 'promql', expr: 'up' },
        sideEffect: false,
        dryRun: false,
      },
    ],
    experience: [],
    visibility: 'private',
  };
}

function copyDefinition(playbook: Playbook): PlaybookDefinition {
  return {
    name: playbook.name,
    description: playbook.description,
    version: playbook.version,
    trigger: clone(playbook.trigger),
    parameters: clone(playbook.parameters),
    steps: clone(playbook.steps),
    experience: clone(playbook.experience),
    visibility: playbook.visibility,
    folderUid: playbook.folderUid,
  };
}

function createGateway(options: Parameters<typeof createFixturePlaybookGateway>[0] = {}) {
  return createFixturePlaybookGateway({
    latencyMs: 0,
    now: () => new Date('2026-07-25T06:00:00.000Z'),
    ...options,
  });
}

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) {
    values.push(value);
  }
  return values;
}

function eventRun(event: PlaybookRunEvent | undefined) {
  if (!event) {
    throw new Error('Expected a run event.');
  }
  return event.type === 'run_updated' ? event.payload : event.payload.run;
}
