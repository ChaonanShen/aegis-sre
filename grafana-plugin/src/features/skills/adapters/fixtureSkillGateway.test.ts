import {
  SkillPermissionError,
  SkillValidationError,
  SkillVersionConflictError,
} from '../errors';
import { Skill, SkillDefinition } from '../model';
import { createFixtureSkillGateway, FixtureSkillGatewayOptions } from './fixtureSkillGateway';

describe('createFixtureSkillGateway', () => {
  test('aggregates accessible shared skills and current user private skills', async () => {
    const skills = await createGateway().listSkills({ folderUids: ['payment'] });
    expect(skills.map(({ id }) => id)).toEqual(expect.arrayContaining(['sk-001', 'sk-003', 'sk-004']));
    expect(skills.map(({ id }) => id)).not.toContain('sk-002');
  });

  test('creates, persists, revises, and deletes a private skill', async () => {
    const storage = memoryStorage();
    const gateway = createGateway({ storage, newId: () => 'sk-new' });
    const created = await gateway.createSkill({ ...validDefinition(), changeNote: '初始创建' });
    expect(created).toMatchObject({ id: 'sk-new', recordVersion: 1, ownerId: 'alice' });

    const updated = await gateway.updateSkill(
      created.id,
      { ...copyDefinition(created), description: '更新后的说明', changeNote: '补充说明' },
      created.recordVersion
    );
    expect(updated).toMatchObject({ recordVersion: 2, description: '更新后的说明' });
    expect(updated.revisions[0]).toMatchObject({ revision: 2, changeNote: '补充说明' });
    expect((await createGateway({ storage }).getSkill(created.id)).description).toBe('更新后的说明');

    await gateway.deleteSkill(updated.id, updated.recordVersion);
    await expect(gateway.getSkill(updated.id)).rejects.toThrow(/不存在/);
  });

  test('enforces source identity, uniqueness, and optimistic versions', async () => {
    const gateway = createGateway();
    const current = await gateway.getSkill('sk-001');
    await expect(
      gateway.updateSkill(
        current.id,
        { ...copyDefinition(current), name: 'renamed', changeNote: '重命名' },
        current.recordVersion
      )
    ).rejects.toThrow(/不可修改/);
    await expect(
      gateway.createSkill({
        ...validDefinition(),
        slashCommand: '/check-cart',
        changeNote: '重复命令',
      })
    ).rejects.toBeInstanceOf(SkillValidationError);
    await expect(
      gateway.updateSkill(
        current.id,
        { ...copyDefinition(current), changeNote: '过期更新' },
        current.recordVersion - 1
      )
    ).rejects.toBeInstanceOf(SkillVersionConflictError);
  });

  test('enforces source and target Folder permissions', async () => {
    const gateway = createGateway();
    const sharedView = await gateway.getSkill('sk-002');
    await expect(
      gateway.updateSkill(
        sharedView.id,
        { ...copyDefinition(sharedView), changeNote: '尝试修改' },
        sharedView.recordVersion
      )
    ).rejects.toBeInstanceOf(SkillPermissionError);
    await expect(
      gateway.createSkill({
        ...validDefinition(),
        visibility: 'shared',
        folderUid: 'infra',
        changeNote: '尝试共享',
      })
    ).rejects.toBeInstanceOf(SkillPermissionError);
  });

  test('validates slash commands, timeouts, tools, and parameter names', async () => {
    const gateway = createGateway();
    await expect(
      gateway.createSkill({ ...validDefinition(), slashCommand: 'missing-slash', changeNote: 'invalid' })
    ).rejects.toThrow(/Slash Command/);
    await expect(
      gateway.createSkill({ ...validDefinition(), timeout: 'soon', changeNote: 'invalid' })
    ).rejects.toThrow(/Timeout/);
    await expect(
      gateway.createSkill({ ...validDefinition(), allowedTools: ['query'], changeNote: 'invalid' })
    ).rejects.toThrow(/server\/tool/);
    await expect(
      gateway.createSkill({
        ...validDefinition(),
        parameters: [
          { name: 'Env', type: 'string', description: '', defaultValue: '', required: false },
        ],
        changeNote: 'invalid',
      })
    ).rejects.toThrow(/Parameter name/);
  });

  test('recovers malformed persisted state', async () => {
    const storage = memoryStorage();
    storage.setItem('fixture', '{broken');
    expect(await createGateway({ storage, storageKey: 'fixture' }).listSkills({ folderUids: ['payment'] })).toHaveLength(
      3
    );
  });

  test('streams read-only dry runs, persists the result, and increments usage', async () => {
    const gateway = createGateway({ newId: () => 'skill-run-new', streamDelayMs: 0 });
    const events = await collect(
      gateway.startDryRun({ skillId: 'sk-001', params: {} }, new AbortController().signal)
    );
    expect(events.at(-1)?.payload).toMatchObject({
      id: 'skill-run-new',
      status: 'success',
      resultMarkdown: expect.stringContaining('checkout-troubleshoot'),
    });
    expect(events.at(-1)?.payload.toolCalls).toHaveLength(3);
    expect((await gateway.getSkill('sk-001')).usageCount).toBe(143);
    expect(await gateway.listRuns('sk-001')).toHaveLength(1);
  });

  test('pauses write tools for HITL and requires write permission to approve', async () => {
    const viewGateway = createGateway({
      newId: () => 'run-view',
      permissions: { payment: 'View' },
      streamDelayMs: 0,
    });
    const waiting = (
      await collect(
        viewGateway.startDryRun({ skillId: 'sk-003', params: {} }, new AbortController().signal)
      )
    ).at(-1)!.payload;
    expect(waiting).toMatchObject({
      status: 'waiting_for_approval',
      pendingInterrupt: { tool: 'grafana_mcp/update_dashboard' },
    });
    await expect(
      collect(
        viewGateway.resolveRun(
          { runId: waiting.id, decision: 'approved' },
          new AbortController().signal
        )
      )
    ).rejects.toBeInstanceOf(SkillPermissionError);
    const skipped = await collect(
      viewGateway.resolveRun(
        { runId: waiting.id, decision: 'skipped' },
        new AbortController().signal
      )
    );
    expect(skipped.at(-1)?.payload.status).toBe('success');
  });

  test('exposes deterministic MCP runtime metadata and cancels a run', async () => {
    const gateway = createGateway({ newId: () => 'run-cancel', streamDelayMs: 20 });
    expect(await gateway.getRuntimeInfo()).toMatchObject({
      status: 'running',
      listenAddress: ':8083/mcp',
      tools: expect.arrayContaining([{ name: 'run_skill', access: 'write', hitl: true }]),
    });
    const stream = gateway.startDryRun(
      { skillId: 'sk-001', params: {} },
      new AbortController().signal
    )[Symbol.asyncIterator]();
    expect((await stream.next()).value?.payload.status).toBe('running');
    expect(await gateway.cancelRun('run-cancel')).toMatchObject({ status: 'cancelled' });
  });
});

function createGateway(options: FixtureSkillGatewayOptions = {}) {
  return createFixtureSkillGateway({
    storage: options.storage ?? memoryStorage(),
    latencyMs: 0,
    now: () => new Date('2026-07-25T08:00:00.000Z'),
    ...options,
  });
}

function validDefinition(): SkillDefinition {
  return {
    name: 'new-skill',
    description: 'A new skill',
    slashCommand: '/new-skill',
    allowedTools: ['grafana_mcp/query_prometheus'],
    timeout: '60s',
    parameters: [],
    tags: ['new'],
    body: '# New skill',
    visibility: 'private',
  };
}

function copyDefinition(skill: Skill): SkillDefinition {
  const { name, description, slashCommand, allowedTools, timeout, parameters, tags, body, visibility, folderUid } =
    skill;
  return { name, description, slashCommand, allowedTools, timeout, parameters, tags, body, visibility, folderUid };
}

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

async function collect(source: AsyncIterable<{ type: 'run_updated'; payload: import('../model').SkillRun }>) {
  const events: Array<{ type: 'run_updated'; payload: import('../model').SkillRun }> = [];
  for await (const event of source) {
    events.push(event);
  }
  return events;
}
