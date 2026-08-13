import { FolderPermission } from '../../../app/model';
import { fixtureFolderPermissions } from '../../../app/fixtures/folderFixtures';
import {
  PlaybookNotFoundError,
  PlaybookPermissionError,
  PlaybookValidationError,
  PlaybookVersionConflictError,
} from '../errors';
import { playbookFixtureData } from '../fixtures/playbookFixtures';
import {
  CreatePlaybookInput,
  Playbook,
  PlaybookData,
  PlaybookDefinition,
  PlaybookDraft,
  PlaybookRun,
  PlaybookRunEvent,
  PlaybookStep,
  ResolvePlaybookRunInput,
  StartPlaybookRunInput,
  UpdatePlaybookInput,
} from '../model';
import { PlaybookGateway } from '../ports/PlaybookGateway';

export const PLAYBOOK_FIXTURE_STORAGE_KEY = 'torchbearing.fixture.playbooks.v1';

export interface FixturePlaybookGatewayOptions {
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  storageKey?: string;
  latencyMs?: number;
  streamDelayMs?: number;
  now?: () => Date;
  newId?: (prefix: string) => string;
  currentUserId?: string;
  permissions?: Record<string, FolderPermission>;
}

export function createFixturePlaybookGateway(options: FixturePlaybookGatewayOptions = {}): PlaybookGateway {
  const storage = options.storage ?? window.sessionStorage;
  const storageKey = options.storageKey ?? PLAYBOOK_FIXTURE_STORAGE_KEY;
  const latencyMs = options.latencyMs ?? 80;
  const streamDelayMs = options.streamDelayMs ?? 180;
  const now = options.now ?? (() => new Date());
  const newId =
    options.newId ?? ((prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  const currentUserId = options.currentUserId ?? 'alice';
  const permissions = options.permissions ?? fixtureFolderPermissions;
  const read = () => readData(storage, storageKey);
  const write = (data: PlaybookData) => storage.setItem(storageKey, JSON.stringify(data));

  return {
    async listPlaybooks({ folderUids }, signal) {
      await delay(latencyMs, signal);
      const allowed = new Set(folderUids);
      return clone(
        read().playbooks.filter(
          ({ visibility, folderUid, ownerId }) =>
            (visibility === 'private' && ownerId === currentUserId) ||
            (visibility === 'shared' && !!folderUid && allowed.has(folderUid))
        )
      ).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },

    async getPlaybook(id, signal) {
      await delay(latencyMs, signal);
      const playbook = findPlaybook(read(), id);
      assertVisible(playbook, currentUserId, permissions);
      return clone(playbook);
    },

    async createPlaybook(input, signal) {
      await delay(latencyMs, signal);
      validatePlaybook(input);
      assertTargetWritable(input, permissions);
      const data = read();
      assertUniqueName(data, input.name);
      const timestamp = now().toISOString();
      const definition = normalizeDefinition(input);
      const created: Playbook = {
        ...definition,
        id: newId('pb'),
        ownerId: currentUserId,
        usageCount: 0,
        recordVersion: 1,
        latestChangeNote: input.changeNote.trim(),
        revisions: [
          {
            revision: 1,
            displayVersion: definition.version,
            author: currentUserId,
            savedAt: timestamp,
            changeNote: input.changeNote.trim(),
            snapshot: clone(definition),
          },
        ],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      data.playbooks.unshift(created);
      write(data);
      return clone(created);
    },

    async updatePlaybook(id, input, expectedVersion, signal) {
      await delay(latencyMs, signal);
      validatePlaybook(input);
      const data = read();
      const index = data.playbooks.findIndex((item) => item.id === id);
      const current = data.playbooks[index];
      if (!current) {
        throw new PlaybookNotFoundError('Playbook', id);
      }
      assertWritable(current, currentUserId, permissions);
      assertTargetWritable(input, permissions);
      if (current.recordVersion !== expectedVersion) {
        throw new PlaybookVersionConflictError(id, expectedVersion, current.recordVersion);
      }
      assertUniqueName(data, input.name, id);
      const timestamp = now().toISOString();
      const definition = normalizeDefinition({ ...input, version: incrementPatch(current.version) });
      const recordVersion = current.recordVersion + 1;
      const updated: Playbook = {
        ...current,
        ...definition,
        recordVersion,
        latestChangeNote: input.changeNote.trim(),
        revisions: [
          {
            revision: recordVersion,
            displayVersion: definition.version,
            author: currentUserId,
            savedAt: timestamp,
            changeNote: input.changeNote.trim(),
            snapshot: clone(definition),
          },
          ...current.revisions,
        ],
        updatedAt: timestamp,
      };
      data.playbooks[index] = updated;
      write(data);
      return clone(updated);
    },

    async deletePlaybook(id, expectedVersion, signal) {
      await delay(latencyMs, signal);
      const data = read();
      const current = findPlaybook(data, id);
      assertWritable(current, currentUserId, permissions);
      if (current.recordVersion !== expectedVersion) {
        throw new PlaybookVersionConflictError(id, expectedVersion, current.recordVersion);
      }
      data.playbooks = data.playbooks.filter((item) => item.id !== id);
      data.drafts = data.drafts.filter((draft) => draft.sourceSessionId !== id);
      data.runs = data.runs.filter((run) => run.playbookId !== id);
      write(data);
    },

    async generateDraft(input, signal) {
      await delay(latencyMs, signal);
      const data = read();
      const timestamp = now().toISOString();
      const slug = slugify(input.sessionTitle) || `session-${input.sessionId}`;
      const draft: PlaybookDraft = {
        id: newId('draft'),
        sourceSessionId: input.sessionId,
        sourceSessionTitle: input.sessionTitle,
        ownerId: currentUserId,
        name: `${slug}-investigation`,
        description: `从会话“${input.sessionTitle}”沉淀的结构化排查流程`,
        version: '0.1',
        trigger: { type: 'manual', alertLabels: {} },
        parameters: [{ name: 'env', type: 'string', defaultValue: 'production', required: true }],
        steps: draftSteps(),
        experience: [],
        visibility: 'private',
        changeNote: `从会话 ${input.sessionId} 生成初始草稿`,
        createdAt: timestamp,
      };
      data.drafts.unshift(draft);
      write(data);
      return clone(draft);
    },

    async getDraft(id, signal) {
      await delay(latencyMs, signal);
      const draft = read().drafts.find((item) => item.id === id);
      if (!draft) {
        throw new PlaybookNotFoundError('Draft', id);
      }
      return clone(draft);
    },

    async discardDraft(id, signal) {
      await delay(latencyMs, signal);
      const data = read();
      if (!data.drafts.some((item) => item.id === id)) {
        throw new PlaybookNotFoundError('Draft', id);
      }
      data.drafts = data.drafts.filter((item) => item.id !== id);
      write(data);
    },

    async listRuns(playbookId, signal) {
      await delay(latencyMs, signal);
      findPlaybook(read(), playbookId);
      return clone(read().runs.filter((run) => run.playbookId === playbookId));
    },

    startDryRun(input, signal) {
      return startRun(input, { read, write, now, newId, currentUserId, permissions, streamDelayMs }, signal);
    },

    resolveRun(input, signal) {
      return resolveRun(input, { read, write, now, currentUserId, permissions, streamDelayMs }, signal);
    },

    async cancelRun(runId, signal) {
      await delay(latencyMs, signal);
      const data = read();
      const run = findRun(data, runId);
      if (run.status === 'success' || run.status === 'failed' || run.status === 'cancelled') {
        return clone(run);
      }
      run.status = 'cancelled';
      run.pendingInterrupt = undefined;
      run.updatedAt = now().toISOString();
      run.endedAt = run.updatedAt;
      write(data);
      return clone(run);
    },

    retryRun(runId, signal) {
      const previous = findRun(read(), runId);
      if (previous.status !== 'failed' && previous.status !== 'cancelled') {
        throw new PlaybookValidationError('只有失败或已取消的 Run 可以重试。');
      }
      return startRun(
        { playbookId: previous.playbookId, params: previous.params, retryOf: previous.id },
        { read, write, now, newId, currentUserId, permissions, streamDelayMs },
        signal
      );
    },
  };
}

interface RunContext {
  read: () => PlaybookData;
  write: (data: PlaybookData) => void;
  now: () => Date;
  newId?: (prefix: string) => string;
  currentUserId: string;
  permissions: Record<string, FolderPermission>;
  streamDelayMs: number;
}

async function* startRun(
  input: StartPlaybookRunInput,
  context: RunContext & { newId: (prefix: string) => string },
  signal: AbortSignal
): AsyncGenerator<PlaybookRunEvent> {
  const data = context.read();
  const playbook = findPlaybook(data, input.playbookId);
  assertVisible(playbook, context.currentUserId, context.permissions);
  validateRunParams(playbook, input.params);
  const timestamp = context.now().toISOString();
  const run: PlaybookRun = {
    id: context.newId('run'),
    playbookId: playbook.id,
    status: 'running',
    dryRun: true,
    params: clone(input.params),
    steps: topologicalSteps(playbook.steps).map((step) => ({
      stepId: step.id,
      label: step.label,
      type: step.type,
      status: 'pending',
    })),
    initiatedBy: context.currentUserId,
    retryOf: input.retryOf,
    startedAt: timestamp,
    updatedAt: timestamp,
  };
  data.runs.unshift(run);
  context.write(data);
  yield { type: 'run_updated', payload: clone(run) };
  yield* continueRun(run.id, context, signal);
}

async function* resolveRun(
  input: ResolvePlaybookRunInput,
  context: RunContext,
  signal: AbortSignal
): AsyncGenerator<PlaybookRunEvent> {
  const data = context.read();
  const run = findRun(data, input.runId);
  const playbook = findPlaybook(data, run.playbookId);
  if (run.status !== 'waiting_for_approval' || !run.pendingInterrupt) {
    throw new PlaybookValidationError('当前运行没有待确认的操作。');
  }
  if (input.decision === 'approved') {
    assertWritable(playbook, context.currentUserId, context.permissions);
  }
  const stepRun = run.steps.find(({ stepId }) => stepId === run.pendingInterrupt?.stepId);
  if (stepRun) {
    stepRun.status = input.decision === 'approved' ? 'success' : 'skipped';
    stepRun.output =
      input.decision === 'approved' ? '已确认 · 未执行真实更改' : '用户选择跳过更改步骤';
    stepRun.durationMs = 0;
  }
  run.pendingInterrupt = undefined;
  run.status = 'running';
  run.updatedAt = context.now().toISOString();
  context.write(data);
  yield { type: 'run_updated', payload: clone(run) };
  yield* continueRun(run.id, context, signal);
}

async function* continueRun(
  runId: string,
  context: RunContext,
  signal: AbortSignal
): AsyncGenerator<PlaybookRunEvent> {
  let data = context.read();
  let run = findRun(data, runId);
  const playbook = findPlaybook(data, run.playbookId);
  const steps = topologicalSteps(playbook.steps);
  for (const step of steps) {
    const stepRun = run.steps.find(({ stepId }) => stepId === step.id)!;
    if (stepRun.status !== 'pending') {
      continue;
    }
    await delay(context.streamDelayMs, signal);
    data = context.read();
    run = findRun(data, runId);
    const current = run.steps.find(({ stepId }) => stepId === step.id)!;
    current.status = 'running';
    run.updatedAt = context.now().toISOString();
    context.write(data);
    yield { type: 'run_updated', payload: clone(run) };

    await delay(context.streamDelayMs, signal);
    data = context.read();
    run = findRun(data, runId);
    const active = run.steps.find(({ stepId }) => stepId === step.id)!;
    if (step.sideEffect) {
      const config = step.config;
      run.status = 'waiting_for_approval';
      run.pendingInterrupt = {
        stepId: step.id,
        server: typeof config.server === 'string' ? config.server : 'unknown',
        tool: typeof config.tool === 'string' ? config.tool : step.type,
        preview: [
          `step: ${step.id}`,
          `type: ${step.type}`,
          `config: ${JSON.stringify(step.config)}`,
          'dry_run: true',
        ],
      };
      run.updatedAt = context.now().toISOString();
      context.write(data);
      yield { type: 'run_updated', payload: clone(run) };
      return;
    }
    if (step.config.fixture_outcome === 'fail' || (step.config.fixture_outcome === 'fail_once' && !run.retryOf)) {
      active.status = 'failed';
      active.error = '步骤执行失败';
      run.status = 'failed';
      run.updatedAt = context.now().toISOString();
      run.endedAt = run.updatedAt;
      context.write(data);
      yield { type: 'run_failed', payload: { run: clone(run), message: active.error } };
      return;
    }
    active.status = 'success';
    active.output = fixtureOutput(step);
    active.durationMs = 640 + run.steps.indexOf(active) * 210;
    run.updatedAt = context.now().toISOString();
    context.write(data);
    yield { type: 'run_updated', payload: clone(run) };
  }

  data = context.read();
  run = findRun(data, runId);
  run.status = 'success';
  run.updatedAt = context.now().toISOString();
  run.endedAt = run.updatedAt;
  const storedPlaybook = findPlaybook(data, run.playbookId);
  storedPlaybook.usageCount += 1;
  context.write(data);
  yield { type: 'run_updated', payload: clone(run) };
}

function validateRunParams(playbook: Playbook, params: Record<string, string>) {
  for (const parameter of playbook.parameters) {
    if (parameter.required && !(params[parameter.name] || parameter.defaultValue)) {
      throw new PlaybookValidationError(`缺少必填参数 "${parameter.name}"。`);
    }
  }
}

function topologicalSteps(steps: PlaybookStep[]): PlaybookStep[] {
  const result: PlaybookStep[] = [];
  const visited = new Set<string>();
  const byId = new Map(steps.map((step) => [step.id, step]));
  const visit = (step: PlaybookStep) => {
    if (visited.has(step.id)) {
      return;
    }
    step.dependsOn.forEach((id) => {
      const parent = byId.get(id);
      if (parent) {
        visit(parent);
      }
    });
    visited.add(step.id);
    result.push(step);
  };
  steps.forEach(visit);
  return result;
}

function fixtureOutput(step: PlaybookStep): string {
  if (step.type === 'query') {
    return `${String(step.config.output ?? 'value')}=320`;
  }
  if (step.type === 'branch') {
    return 'condition=true';
  }
  if (step.type === 'template') {
    return 'Markdown 汇总报告已生成';
  }
  return '运行预览已完成';
}

function findRun(data: PlaybookData, id: string): PlaybookRun {
  const run = data.runs.find((item) => item.id === id);
  if (!run) {
    throw new PlaybookNotFoundError('Run', id);
  }
  return run;
}

function validatePlaybook(input: CreatePlaybookInput | UpdatePlaybookInput) {
  if (!input.name.trim() || !/^[a-z0-9][a-z0-9-]*$/.test(input.name.trim())) {
    throw new PlaybookValidationError('Playbook name 只能使用小写字母、数字和连字符。');
  }
  if (!input.description.trim()) {
    throw new PlaybookValidationError('Description 不能为空。');
  }
  if (!input.changeNote.trim()) {
    throw new PlaybookValidationError('保存前必须填写变更说明。');
  }
  if (input.trigger.type === 'alert' && !input.trigger.pattern?.trim()) {
    throw new PlaybookValidationError('Alert Trigger 必须填写 pattern。');
  }
  const parameterNames = input.parameters.map(({ name }) => name.trim());
  if (parameterNames.some((name) => !name) || new Set(parameterNames).size !== parameterNames.length) {
    throw new PlaybookValidationError('Parameter name 不能为空且不能重复。');
  }
  validateSteps(input.steps);
}

function validateSteps(steps: PlaybookStep[]) {
  if (steps.length === 0) {
    throw new PlaybookValidationError('Playbook 至少需要一个 Step。');
  }
  const ids = steps.map(({ id }) => id.trim());
  if (ids.some((id) => !/^[a-z][a-z0-9_]*$/.test(id)) || new Set(ids).size !== ids.length) {
    throw new PlaybookValidationError('Step ID 必须唯一，并使用小写字母、数字和下划线。');
  }
  const idSet = new Set(ids);
  for (const step of steps) {
    if (!step.label.trim()) {
      throw new PlaybookValidationError(`Step "${step.id}" 缺少名称。`);
    }
    if (step.dependsOn.some((dependency) => !idSet.has(dependency) || dependency === step.id)) {
      throw new PlaybookValidationError(`Step "${step.id}" 存在无效依赖。`);
    }
    if (step.type === 'query' && step.config.dialect !== 'promql') {
      throw new PlaybookValidationError(`Query Step "${step.id}" 目前只支持 promql。`);
    }
    if (step.type === 'branch' && typeof step.config.condition !== 'string') {
      throw new PlaybookValidationError(`Branch Step "${step.id}" 缺少 condition。`);
    }
    if (
      step.type === 'mcp_call' &&
      (typeof step.config.server !== 'string' || typeof step.config.tool !== 'string')
    ) {
      throw new PlaybookValidationError(`MCP Step "${step.id}" 缺少 server 或 tool。`);
    }
    if (step.type === 'template' && typeof step.config.template !== 'string') {
      throw new PlaybookValidationError(`Template Step "${step.id}" 缺少 template。`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(steps.map((step) => [step.id, step]));
  const visit = (id: string) => {
    if (visiting.has(id)) {
      throw new PlaybookValidationError('Step 依赖不能形成环。');
    }
    if (visited.has(id)) {
      return;
    }
    visiting.add(id);
    byId.get(id)?.dependsOn.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  };
  ids.forEach(visit);
}

function assertUniqueName(data: PlaybookData, name: string, exceptId?: string) {
  if (data.playbooks.some((item) => item.id !== exceptId && item.name === name.trim())) {
    throw new PlaybookValidationError(`Playbook "${name.trim()}" 已存在。`);
  }
}

function assertVisible(
  playbook: Playbook,
  currentUserId: string,
  permissions: Record<string, FolderPermission>
) {
  if (
    (playbook.visibility === 'private' && playbook.ownerId !== currentUserId) ||
    (playbook.visibility === 'shared' && (!playbook.folderUid || !permissions[playbook.folderUid]))
  ) {
    throw new PlaybookPermissionError('无权查看此 Playbook。');
  }
}

function assertWritable(
  playbook: Playbook,
  currentUserId: string,
  permissions: Record<string, FolderPermission>
) {
  if (playbook.visibility === 'private') {
    if (playbook.ownerId !== currentUserId) {
      throw new PlaybookPermissionError('只有 owner 可以修改 private Playbook。');
    }
    return;
  }
  assertFolderWritable(playbook.folderUid, permissions);
}

function assertTargetWritable(
  input: Pick<PlaybookDefinition, 'visibility' | 'folderUid'>,
  permissions: Record<string, FolderPermission>
) {
  if (input.visibility === 'shared') {
    assertFolderWritable(input.folderUid, permissions);
  } else if (input.folderUid) {
    throw new PlaybookValidationError('private Playbook 不能绑定 Folder。');
  }
}

function assertFolderWritable(folderUid: string | undefined, permissions: Record<string, FolderPermission>) {
  if (!folderUid) {
    throw new PlaybookValidationError('shared Playbook 必须绑定 Folder。');
  }
  if (permissions[folderUid] !== 'Edit' && permissions[folderUid] !== 'Admin') {
    throw new PlaybookPermissionError(`Folder "${folderUid}" 没有写权限。`);
  }
}

function findPlaybook(data: PlaybookData, id: string): Playbook {
  const playbook = data.playbooks.find((item) => item.id === id);
  if (!playbook) {
    throw new PlaybookNotFoundError('Playbook', id);
  }
  return playbook;
}

function normalizeDefinition(input: PlaybookDefinition): PlaybookDefinition {
  return {
    name: input.name.trim(),
    description: input.description.trim(),
    version: input.version.trim(),
    trigger: clone(input.trigger),
    parameters: clone(input.parameters),
    steps: clone(input.steps),
    experience: clone(input.experience),
    visibility: input.visibility,
    folderUid: input.visibility === 'shared' ? input.folderUid : undefined,
  };
}

function incrementPatch(version: string): string {
  const match = version.match(/^(\d+)\.(\d+)(?:\.(\d+))?$/);
  if (!match) {
    return '0.1.1';
  }
  return `${match[1]}.${match[2]}.${Number(match[3] ?? 0) + 1}`;
}

function slugify(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function draftSteps(): PlaybookStep[] {
  return [
    {
      id: 'collect_metrics',
      type: 'query',
      label: '收集关键指标',
      dependsOn: [],
      config: { dialect: 'promql', datasource: 'prometheus-prod', expr: 'up' },
      sideEffect: false,
      dryRun: false,
    },
    {
      id: 'summarize',
      type: 'template',
      label: '汇总排查结果',
      dependsOn: ['collect_metrics'],
      config: { template: '# 排查结果\n\n{{ .collect_metrics }}' },
      sideEffect: false,
      dryRun: false,
    },
  ];
}

function readData(storage: Pick<Storage, 'getItem' | 'setItem'>, key: string): PlaybookData {
  try {
    const raw = storage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as PlaybookData;
      if (parsed.schemaVersion === 1 && Array.isArray(parsed.playbooks) && Array.isArray(parsed.drafts)) {
        return { ...parsed, runs: Array.isArray(parsed.runs) ? parsed.runs : [] };
      }
    }
  } catch {
    // Re-seed malformed Fixture state below.
  }
  const seeded = clone(playbookFixtureData);
  storage.setItem(key, JSON.stringify(seeded));
  return seeded;
}

function delay(durationMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('The operation was aborted.', 'AbortError'));
  }
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(resolve, durationMs);
    signal?.addEventListener(
      'abort',
      () => {
        window.clearTimeout(timeout);
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      },
      { once: true }
    );
  });
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
