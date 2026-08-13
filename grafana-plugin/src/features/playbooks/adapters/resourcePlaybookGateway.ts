import { BackendSrv, BackendSrvRequest, getBackendSrv } from '@grafana/runtime';
import { Observable } from 'rxjs';
import type { components } from '../../../api/generated/controlPlane';
import { ResourceClient, ResourceClientError } from '../../../adapters/resourcesdk/resourceClient';
import { PLUGIN_RESOURCE_BASE_URL } from '../../../constants';
import { projectDaguSource } from '../daguSource';
import {
  CreatePlaybookInput,
  Playbook,
  PlaybookRun,
  PlaybookRunEvent,
  StartPlaybookRunInput,
  UpdatePlaybookInput,
} from '../model';
import { PlaybookGateway } from '../ports/PlaybookGateway';

type ContractPlaybook = components['schemas']['Playbook'];
type ContractPlaybookPage = components['schemas']['PlaybookPage'];
type ContractRun = components['schemas']['PlaybookRun'];
type ContractRunPage = components['schemas']['PlaybookRunPage'];

// 旧 UI 把真实 Dagu Run 包装成 dry-run。兼容窗口内保留代码用于回退比对，但禁止再发起任何执行写操作。
const LEGACY_EXECUTION_DISABLED = true;

export function createResourcePlaybookGateway(options: { backendSrv?: BackendSrv; resourceClient?: ResourceClient } = {}): PlaybookGateway {
  let backend: BackendSrv | undefined;
  let resources: ResourceClient | undefined;
  const backendSrv = () => (backend ??= options.backendSrv ?? getBackendSrv());
  const client = () => (resources ??= options.resourceClient ?? new ResourceClient(backendSrv()));
  return {
    async listPlaybooks(_input, signal) {
      const page = await client().request('/api/v1/playbooks', isPlaybookPage, { signal });
      return Promise.all(page.items.map(async (item) => toPlaybook(await client().request(playbookPath(item.id), isPlaybook, { signal }))));
    },
    async getPlaybook(id, signal) {
      return toPlaybook(await client().request(playbookPath(id), isPlaybook, { signal }));
    },
    async createPlaybook(input, signal) {
      return toPlaybook(await writePlaybook(client(), '/api/v1/playbooks', 'POST', input, signal));
    },
    async updatePlaybook(id, input, _expectedVersion, signal) {
      return toPlaybook(await writePlaybook(client(), playbookPath(id), 'PUT', input, signal));
    },
    async deletePlaybook(id, _expectedVersion, signal) {
      await client().requestVoid(playbookPath(id), { method: 'DELETE', signal });
    },
    async generateDraft() {
      throw unavailable('对话生成 Playbook 草稿尚未接入真实 Agent。');
    },
    async getDraft() {
      throw unavailable('Playbook 草稿存储不属于 Dagu。');
    },
    async discardDraft() {
      throw unavailable('Playbook 草稿存储不属于 Dagu。');
    },
    async listRuns(playbookId, signal) {
      const page = await client().request(`${playbookPath(playbookId)}/runs`, isRunPage, { signal });
      return page.items.map(toRun);
    },
    startDryRun(input, signal) {
      if (LEGACY_EXECUTION_DISABLED) {
        return disabledLegacyExecution();
      }
      return startRun(client(), backendSrv(), input, signal);
    },
    resolveRun(input, signal) {
      if (LEGACY_EXECUTION_DISABLED) {
        return disabledLegacyExecution();
      }
      return resolveRun(client(), backendSrv(), input.runId, input.decision === 'approved' ? 'approve' : 'reject', signal);
    },
    async cancelRun(runId, signal) {
      if (LEGACY_EXECUTION_DISABLED) {
        throw unavailable('旧 Playbook dry-run 执行入口已停用，请使用当前运行记录页面。');
      }
      await client().requestVoid(`/api/v1/runs/${encodeURIComponent(runId)}:cancel`, { method: 'POST', signal });
      return toRun(await client().request(`/api/v1/runs/${encodeURIComponent(runId)}`, isRun, { signal }));
    },
    retryRun(runId, signal) {
      if (LEGACY_EXECUTION_DISABLED) {
        return disabledLegacyExecution();
      }
      return retryRun(client(), backendSrv(), runId, signal);
    },
  };
}

async function* disabledLegacyExecution(): AsyncGenerator<PlaybookRunEvent> {
  throw unavailable('旧 Playbook dry-run 执行入口已停用，请使用当前运行记录页面。');
}

async function writePlaybook(client: ResourceClient, path: string, method: string, input: CreatePlaybookInput | UpdatePlaybookInput, signal?: AbortSignal) {
  if (!input.source?.trim()) {
    throw new ResourceClientError(400, 'invalid_argument', '真实模式必须提交原生 Dagu YAML。');
  }
  projectDaguSource(input.source);
  return client.request(path, isPlaybook, {
    method,
    data: input.source,
    headers: { 'Content-Type': 'application/yaml', ...(method === 'POST' ? { 'Idempotency-Key': newKey('playbook') } : {}) },
    signal,
  });
}

async function* startRun(client: ResourceClient, backend: BackendSrv, input: StartPlaybookRunInput, signal: AbortSignal): AsyncGenerator<PlaybookRunEvent> {
  const run = toRun(await client.request(`${playbookPath(input.playbookId)}/runs`, isRun, {
    method: 'POST', data: { parameters: input.params }, headers: { 'Idempotency-Key': newKey('run') }, signal,
  }));
  yield { type: 'run_updated', payload: run };
  yield* streamRun(backend, run, signal);
}

async function* retryRun(client: ResourceClient, backend: BackendSrv, runId: string, signal: AbortSignal): AsyncGenerator<PlaybookRunEvent> {
  const run = toRun(await client.request(`/api/v1/runs/${encodeURIComponent(runId)}:retry`, isRun, {
    method: 'POST', headers: { 'Idempotency-Key': newKey('retry') }, signal,
  }));
  yield { type: 'run_updated', payload: run };
  yield* streamRun(backend, run, signal);
}

async function* resolveRun(client: ResourceClient, backend: BackendSrv, runId: string, decision: 'approve' | 'reject', signal: AbortSignal): AsyncGenerator<PlaybookRunEvent> {
  const current = await client.request(`/api/v1/runs/${encodeURIComponent(runId)}`, isRun, { signal });
  const step = current.steps?.find((item) => item.status === 'waiting_for_approval');
  if (!step) {
    throw new ResourceClientError(409, 'conflict', '当前 Run 没有待处理的 Dagu Approval。');
  }
  await client.requestVoid(`/api/v1/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(step.id)}:resolve`, {
    method: 'POST', data: { decision }, headers: { 'Idempotency-Key': newKey('approval') }, signal,
  });
  yield* streamRun(backend, toRun(current), signal);
}

async function* streamRun(backend: BackendSrv, initial: PlaybookRun, signal: AbortSignal): AsyncGenerator<PlaybookRunEvent> {
  const request: BackendSrvRequest = {
    url: `${PLUGIN_RESOURCE_BASE_URL}/api/v1/runs/${encodeURIComponent(initial.id)}/events?after_sequence=0`,
    method: 'GET', abortSignal: signal, showErrorAlert: false, validatePath: true,
  };
  let current = initial;
  const decoder = new SSEDecoder();
  for await (const response of observableValues(backend.chunked(request), signal)) {
    if (response.status < 200 || response.status >= 300) {
      throw new ResourceClientError(response.status, response.status, 'Playbook 事件流请求失败。');
    }
    for (const data of decoder.push(response.data)) {
      const event = JSON.parse(data) as { event_type?: string; payload?: { status?: PlaybookRun['status'] } };
      if (event.event_type !== 'run.updated' || !event.payload?.status) {
        continue;
      }
      current = { ...current, status: event.payload.status, updatedAt: new Date().toISOString() };
      yield { type: 'run_updated', payload: current };
    }
  }
  decoder.finish();
}

function toPlaybook(value: ContractPlaybook): Playbook {
  if (!value.source) {
    throw new ResourceClientError(200, 0, 'Dagu Playbook 响应缺少原生 YAML。');
  }
  const projected = projectDaguSource(value.source);
  return {
    ...projected,
    source: value.source,
    version: 'dagu-native',
    trigger: { type: 'manual', alertLabels: {} },
    experience: [],
    visibility: 'private',
    id: value.id,
    ownerId: 'dagu',
    usageCount: 0,
    recordVersion: 1,
    latestChangeNote: '',
    revisions: [],
    createdAt: '',
    updatedAt: '',
  };
}

function toRun(value: ContractRun): PlaybookRun {
  const steps = value.steps ?? [];
  const waiting = steps.find((step) => step.status === 'waiting_for_approval');
  return {
    id: value.id,
    playbookId: value.playbook_id,
    status: value.status === 'cancelled' ? 'cancelled' : value.status === 'succeeded' ? 'success' : value.status === 'waiting_for_input' || value.status === 'waiting_for_approval' ? 'waiting_for_approval' : value.status === 'failed' ? 'failed' : 'running',
    dryRun: true,
    params: {},
    steps: steps.map((step) => ({
      stepId: step.id,
      label: step.name,
      type: 'query',
      status: step.status === 'succeeded' ? 'success' : step.status === 'cancelled' || step.status === 'failed' ? 'failed' : step.status === 'running' ? 'running' : 'pending',
    })),
    ...(waiting ? { pendingInterrupt: { stepId: waiting.id, server: 'dagu', tool: 'approval', preview: [] } } : {}),
    initiatedBy: '',
    startedAt: value.started_at,
    updatedAt: value.updated_at,
    endedAt: value.ended_at,
  };
}

function isPlaybook(value: unknown): value is ContractPlaybook {
  const item = record(value);
  return Boolean(item && typeof item.id === 'string' && typeof item.name === 'string' && typeof item.status === 'string');
}
function isPlaybookPage(value: unknown): value is ContractPlaybookPage {
  const page = record(value);
  return Boolean(page && Array.isArray(page.items) && page.items.every(isPlaybook) && typeof page.has_more === 'boolean');
}
function isRun(value: unknown): value is ContractRun {
  const run = record(value);
  return Boolean(run && typeof run.id === 'string' && typeof run.playbook_id === 'string' && typeof run.status === 'string');
}
function isRunPage(value: unknown): value is ContractRunPage {
  const page = record(value);
  return Boolean(page && Array.isArray(page.items) && page.items.every(isRun) && typeof page.has_more === 'boolean');
}
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function playbookPath(id: string) { return `/api/v1/playbooks/${encodeURIComponent(id)}`; }
function newKey(prefix: string) { return `${prefix}-${crypto.randomUUID()}`; }
function unavailable(message: string) { return new ResourceClientError(503, 'capability_unavailable', message); }

class SSEDecoder {
  private buffer = '';
  private readonly decoder = new TextDecoder();
  push(chunk?: Uint8Array): string[] {
    this.buffer += chunk ? this.decoder.decode(chunk, { stream: true }).replaceAll('\r\n', '\n') : '';
    return this.drain();
  }
  finish() {
    this.buffer += this.decoder.decode();
    if (this.buffer.trim()) {
      throw new ResourceClientError(200, 0, 'Playbook SSE 事件未完整结束。');
    }
  }
  private drain(): string[] {
    const values: string[] = [];
    for (;;) {
      const boundary = this.buffer.indexOf('\n\n');
      if (boundary < 0) { return values; }
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (data) { values.push(data); }
    }
  }
}

async function* observableValues<T>(observable: Observable<T>, signal: AbortSignal): AsyncGenerator<T> {
  type Item = { value: T } | { error: unknown } | { done: true };
  const queue: Item[] = [];
  let wake: (() => void) | undefined;
  const enqueue = (item: Item) => { queue.push(item); wake?.(); wake = undefined; };
  const subscription = observable.subscribe({ next: (value) => enqueue({ value }), error: (error) => enqueue({ error }), complete: () => enqueue({ done: true }) });
  const abort = () => { subscription.unsubscribe(); enqueue({ error: new DOMException('The operation was aborted.', 'AbortError') }); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      if (!queue.length) { await new Promise<void>((resolve) => { wake = resolve; }); }
      const item = queue.shift();
      if (!item) { continue; }
      if ('value' in item) { yield item.value; } else if ('error' in item) { throw item.error; } else { return; }
    }
  } finally {
    signal.removeEventListener('abort', abort);
    subscription.unsubscribe();
  }
}
