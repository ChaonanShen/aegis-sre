import { fixtureFolderPermissions } from '../../../app/fixtures/folderFixtures';
import { FolderPermission } from '../../../app/model';
import {
  SkillNotFoundError,
  SkillPermissionError,
  SkillValidationError,
  SkillVersionConflictError,
} from '../errors';
import { skillFixtureData } from '../fixtures/skillFixtures';
import {
  CreateSkillInput,
  ResolveSkillRunInput,
  Skill,
  SkillData,
  SkillDefinition,
  SkillRun,
  SkillRunEvent,
  StartSkillRunInput,
  UpdateSkillInput,
} from '../model';
import { SkillGateway } from '../ports/SkillGateway';

export const SKILL_FIXTURE_STORAGE_KEY = 'torchbearing.fixture.skills.v1';

export interface FixtureSkillGatewayOptions {
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  storageKey?: string;
  latencyMs?: number;
  streamDelayMs?: number;
  now?: () => Date;
  newId?: (prefix?: string) => string;
  currentUserId?: string;
  permissions?: Record<string, FolderPermission>;
}

export function createFixtureSkillGateway(options: FixtureSkillGatewayOptions = {}): SkillGateway {
  const storage = options.storage ?? window.sessionStorage;
  const storageKey = options.storageKey ?? SKILL_FIXTURE_STORAGE_KEY;
  const latencyMs = options.latencyMs ?? 80;
  const streamDelayMs = options.streamDelayMs ?? 180;
  const now = options.now ?? (() => new Date());
  const newId =
    options.newId ?? ((prefix = 'sk') => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  const currentUserId = options.currentUserId ?? 'alice';
  const permissions = options.permissions ?? fixtureFolderPermissions;
  const read = () => readData(storage, storageKey);
  const write = (data: SkillData) => storage.setItem(storageKey, JSON.stringify(data));

  return {
    async listSkills({ folderUids }, signal) {
      await delay(latencyMs, signal);
      const allowed = new Set(folderUids);
      return clone(
        read().skills.filter(
          ({ visibility, folderUid, ownerId }) =>
            (visibility === 'private' && ownerId === currentUserId) ||
            (visibility === 'shared' && !!folderUid && allowed.has(folderUid))
        )
      ).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },

    async getSkill(id, signal) {
      await delay(latencyMs, signal);
      const skill = findSkill(read(), id);
      assertVisible(skill, currentUserId, permissions);
      return clone(skill);
    },

    async createSkill(input, signal) {
      await delay(latencyMs, signal);
      validateSkill(input);
      assertTargetWritable(input, permissions);
      const data = read();
      assertUniqueIdentity(data, input);
      const timestamp = now().toISOString();
      const definition = normalizeDefinition(input);
      const created: Skill = {
        ...definition,
        id: newId(),
        ownerId: currentUserId,
        usageCount: 0,
        recordVersion: 1,
        latestChangeNote: input.changeNote.trim(),
        revisions: [
          {
            revision: 1,
            author: currentUserId,
            savedAt: timestamp,
            changeNote: input.changeNote.trim(),
            snapshot: clone(definition),
          },
        ],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      data.skills.unshift(created);
      write(data);
      return clone(created);
    },

    async updateSkill(id, input, expectedVersion, signal) {
      await delay(latencyMs, signal);
      validateSkill(input);
      const data = read();
      const index = data.skills.findIndex((item) => item.id === id);
      const current = data.skills[index];
      if (!current) {
        throw new SkillNotFoundError(id);
      }
      assertWritable(current, currentUserId, permissions);
      assertTargetWritable(input, permissions);
      if (current.recordVersion !== expectedVersion) {
        throw new SkillVersionConflictError(id, expectedVersion, current.recordVersion);
      }
      if (input.name.trim() !== current.name) {
        throw new SkillValidationError('Skill name / 文件名当前不可修改。');
      }
      assertUniqueIdentity(data, input, id);
      const timestamp = now().toISOString();
      const definition = normalizeDefinition(input);
      const recordVersion = current.recordVersion + 1;
      const updated: Skill = {
        ...current,
        ...definition,
        recordVersion,
        latestChangeNote: input.changeNote.trim(),
        revisions: [
          {
            revision: recordVersion,
            author: currentUserId,
            savedAt: timestamp,
            changeNote: input.changeNote.trim(),
            snapshot: clone(definition),
          },
          ...current.revisions,
        ],
        updatedAt: timestamp,
      };
      data.skills[index] = updated;
      write(data);
      return clone(updated);
    },

    async deleteSkill(id, expectedVersion, signal) {
      await delay(latencyMs, signal);
      const data = read();
      const current = findSkill(data, id);
      assertWritable(current, currentUserId, permissions);
      if (current.recordVersion !== expectedVersion) {
        throw new SkillVersionConflictError(id, expectedVersion, current.recordVersion);
      }
      data.skills = data.skills.filter((item) => item.id !== id);
      data.runs = data.runs.filter((run) => run.skillId !== id);
      write(data);
    },

    async getRuntimeInfo(signal) {
      await delay(latencyMs, signal);
      return {
        status: 'running',
        listenAddress: ':8083/mcp',
        clientUrl: 'http://assistant-mcp:8080/mcp',
        tools: [
          runtimeTool('list_skills', 'read'),
          runtimeTool('search_skills', 'read'),
          runtimeTool('get_skill', 'read'),
          runtimeTool('load_skill_for_agent', 'read'),
          runtimeTool('run_skill', 'write'),
          runtimeTool('create_skill', 'write'),
          runtimeTool('update_skill', 'write'),
          runtimeTool('delete_skill', 'write'),
          runtimeTool('promote_skill', 'write'),
        ],
      };
    },

    async listRuns(skillId, signal) {
      await delay(latencyMs, signal);
      const data = read();
      const skill = findSkill(data, skillId);
      assertVisible(skill, currentUserId, permissions);
      return clone(data.runs.filter((run) => run.skillId === skillId));
    },

    startDryRun(input, signal) {
      return startRun(
        input,
        { read, write, now, newId, currentUserId, permissions, streamDelayMs },
        signal
      );
    },

    resolveRun(input, signal) {
      return resolveRun(
        input,
        { read, write, now, currentUserId, permissions, streamDelayMs },
        signal
      );
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
  };
}

interface RunContext {
  read: () => SkillData;
  write: (data: SkillData) => void;
  now: () => Date;
  newId?: (prefix?: string) => string;
  currentUserId: string;
  permissions: Record<string, FolderPermission>;
  streamDelayMs: number;
}

async function* startRun(
  input: StartSkillRunInput,
  context: RunContext & { newId: (prefix?: string) => string },
  signal: AbortSignal
): AsyncGenerator<SkillRunEvent> {
  const data = context.read();
  const skill = findSkill(data, input.skillId);
  assertVisible(skill, context.currentUserId, context.permissions);
  for (const parameter of skill.parameters) {
    if (parameter.required && !(input.params[parameter.name] || parameter.defaultValue)) {
      throw new SkillValidationError(`缺少必填参数 "${parameter.name}"。`);
    }
  }
  const timestamp = context.now().toISOString();
  const run: SkillRun = {
    id: context.newId('skill-run'),
    skillId: skill.id,
    status: 'running',
    dryRun: true,
    params: clone(input.params),
    toolCalls: skill.allowedTools.map((tool, index) => ({
      id: `call-${index + 1}`,
      tool,
      status: 'pending',
      input: { skill: skill.name, ...input.params },
    })),
    initiatedBy: context.currentUserId,
    startedAt: timestamp,
    updatedAt: timestamp,
  };
  data.runs.unshift(run);
  context.write(data);
  yield { type: 'run_updated', payload: clone(run) };
  yield* continueRun(run.id, context, signal);
}

async function* resolveRun(
  input: ResolveSkillRunInput,
  context: RunContext,
  signal: AbortSignal
): AsyncGenerator<SkillRunEvent> {
  const data = context.read();
  const run = findRun(data, input.runId);
  const skill = findSkill(data, run.skillId);
  if (run.status !== 'waiting_for_approval' || !run.pendingInterrupt) {
    throw new SkillValidationError('当前 Skill 运行没有待确认的操作。');
  }
  if (input.decision === 'approved') {
    assertWritable(skill, context.currentUserId, context.permissions);
  }
  const call = run.toolCalls.find(({ id }) => id === run.pendingInterrupt?.callId);
  if (call) {
    call.status = input.decision === 'approved' ? 'success' : 'skipped';
    call.output =
      input.decision === 'approved'
        ? '已确认 · 未执行真实写操作'
        : '用户选择跳过写操作';
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
): AsyncGenerator<SkillRunEvent> {
  let data = context.read();
  let run = findRun(data, runId);
  const skill = findSkill(data, run.skillId);
  for (const toolCall of run.toolCalls) {
    if (toolCall.status !== 'pending') {
      continue;
    }
    await delay(context.streamDelayMs, signal);
    data = context.read();
    run = findRun(data, runId);
    const current = run.toolCalls.find(({ id }) => id === toolCall.id)!;
    current.status = 'running';
    run.updatedAt = context.now().toISOString();
    context.write(data);
    yield { type: 'run_updated', payload: clone(run) };

    await delay(context.streamDelayMs, signal);
    data = context.read();
    run = findRun(data, runId);
    const active = run.toolCalls.find(({ id }) => id === toolCall.id)!;
    if (isWriteTool(active.tool)) {
      run.status = 'waiting_for_approval';
      run.pendingInterrupt = {
        callId: active.id,
        tool: active.tool,
        preview: [
          `tool: ${active.tool}`,
          `input: ${JSON.stringify(active.input)}`,
          'dry_run: true',
          'effect: no real write will be executed',
        ],
      };
      run.updatedAt = context.now().toISOString();
      context.write(data);
      yield { type: 'run_updated', payload: clone(run) };
      return;
    }
    active.status = 'success';
    active.output = `fixture result · ${active.tool} 查询完成`;
    run.updatedAt = context.now().toISOString();
    context.write(data);
    yield { type: 'run_updated', payload: clone(run) };
  }

  data = context.read();
  run = findRun(data, runId);
  run.status = 'success';
  run.resultMarkdown = `# ${skill.name} 运行预览报告\n\n已完成 ${run.toolCalls.length} 个工具调用。`;
  run.updatedAt = context.now().toISOString();
  run.endedAt = run.updatedAt;
  findSkill(data, run.skillId).usageCount += 1;
  context.write(data);
  yield { type: 'run_updated', payload: clone(run) };
}

function isWriteTool(tool: string): boolean {
  return /(?:create|update|delete|write|rollback|restart|deploy)/i.test(tool.split('/').at(-1) ?? tool);
}

function findRun(data: SkillData, id: string): SkillRun {
  const run = data.runs.find((item) => item.id === id);
  if (!run) {
    throw new SkillNotFoundError(id);
  }
  return run;
}

function runtimeTool(name: string, access: 'read' | 'write') {
  return { name, access, hitl: access === 'write' };
}

function validateSkill(input: CreateSkillInput | UpdateSkillInput) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(input.name.trim())) {
    throw new SkillValidationError('Skill name 只能使用小写字母、数字和连字符。');
  }
  if (!input.description.trim() || !input.body.trim()) {
    throw new SkillValidationError('Description 和 Markdown 正文不能为空。');
  }
  if (!/^\/[a-z0-9][a-z0-9-]*$/.test(input.slashCommand.trim())) {
    throw new SkillValidationError('Slash Command 必须以 / 开头，并使用小写字母、数字和连字符。');
  }
  if (!/^\d+(?:ms|s|m)$/.test(input.timeout.trim())) {
    throw new SkillValidationError('Timeout 必须使用 500ms、60s 或 2m 格式。');
  }
  if (!input.changeNote.trim()) {
    throw new SkillValidationError('保存前必须填写变更说明。');
  }
  if (input.allowedTools.some((tool) => !/^[a-z0-9_-]+\/[a-z0-9_-]+$/i.test(tool))) {
    throw new SkillValidationError('Allowed Tool 必须使用 server/tool 格式。');
  }
  const names = input.parameters.map(({ name }) => name.trim());
  if (names.some((name) => !/^[a-z][a-z0-9_]*$/.test(name)) || new Set(names).size !== names.length) {
    throw new SkillValidationError('Parameter name 必须唯一，并使用小写字母、数字和下划线。');
  }
}

function assertUniqueIdentity(data: SkillData, input: Pick<SkillDefinition, 'name' | 'slashCommand'>, exceptId?: string) {
  if (data.skills.some(({ id, name }) => id !== exceptId && name === input.name.trim())) {
    throw new SkillValidationError(`Skill "${input.name.trim()}" 已存在。`);
  }
  if (data.skills.some(({ id, slashCommand }) => id !== exceptId && slashCommand === input.slashCommand.trim())) {
    throw new SkillValidationError(`Slash Command "${input.slashCommand.trim()}" 已存在。`);
  }
}

function assertVisible(skill: Skill, currentUserId: string, permissions: Record<string, FolderPermission>) {
  if (
    (skill.visibility === 'private' && skill.ownerId !== currentUserId) ||
    (skill.visibility === 'shared' && (!skill.folderUid || !permissions[skill.folderUid]))
  ) {
    throw new SkillPermissionError('无权查看此 Skill。');
  }
}

function assertWritable(skill: Skill, currentUserId: string, permissions: Record<string, FolderPermission>) {
  if (skill.visibility === 'private') {
    if (skill.ownerId !== currentUserId) {
      throw new SkillPermissionError('只有 owner 可以修改 private Skill。');
    }
    return;
  }
  assertFolderWritable(skill.folderUid, permissions);
}

function assertTargetWritable(
  input: Pick<SkillDefinition, 'visibility' | 'folderUid'>,
  permissions: Record<string, FolderPermission>
) {
  if (input.visibility === 'shared') {
    assertFolderWritable(input.folderUid, permissions);
  } else if (input.folderUid) {
    throw new SkillValidationError('private Skill 不能绑定 Folder。');
  }
}

function assertFolderWritable(folderUid: string | undefined, permissions: Record<string, FolderPermission>) {
  if (!folderUid) {
    throw new SkillValidationError('shared Skill 必须绑定 Folder。');
  }
  if (permissions[folderUid] !== 'Edit' && permissions[folderUid] !== 'Admin') {
    throw new SkillPermissionError(`Folder "${folderUid}" 没有写权限。`);
  }
}

function findSkill(data: SkillData, id: string): Skill {
  const skill = data.skills.find((item) => item.id === id);
  if (!skill) {
    throw new SkillNotFoundError(id);
  }
  return skill;
}

function normalizeDefinition(input: SkillDefinition): SkillDefinition {
  return {
    name: input.name.trim(),
    description: input.description.trim(),
    slashCommand: input.slashCommand.trim(),
    allowedTools: input.allowedTools.map((item) => item.trim()).filter(Boolean),
    timeout: input.timeout.trim(),
    parameters: clone(input.parameters),
    tags: input.tags.map((item) => item.trim()).filter(Boolean),
    body: input.body.trim(),
    visibility: input.visibility,
    folderUid: input.visibility === 'shared' ? input.folderUid : undefined,
  };
}

function readData(storage: Pick<Storage, 'getItem' | 'setItem'>, key: string): SkillData {
  try {
    const raw = storage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw) as SkillData;
      if (parsed.schemaVersion === 1 && Array.isArray(parsed.skills)) {
        return { ...parsed, runs: Array.isArray(parsed.runs) ? parsed.runs : [] };
      }
    }
  } catch {
    // Re-seed malformed Fixture state below.
  }
  const seeded = clone(skillFixtureData);
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
