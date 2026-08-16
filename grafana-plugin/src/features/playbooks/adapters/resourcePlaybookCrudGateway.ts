import { BackendSrv, BackendSrvRequest, getBackendSrv } from '@grafana/runtime';
import { Observable } from 'rxjs';
import type { components } from '../../../api/generated/controlPlane';
import { ResourceClient, ResourceClientError } from '../../../adapters/resourcesdk/resourceClient';
import { PLUGIN_RESOURCE_BASE_URL } from '../../../constants';
import { PlaybookArtifact, PlaybookArtifactPreview, PlaybookDocument, PlaybookRunRecord, PlaybookSummary } from '../crudModel';
import { PlaybookCrudGateway } from '../ports/PlaybookCrudGateway';

type ContractPlaybook = components['schemas']['Playbook'];
type ContractSummary = components['schemas']['PlaybookSummary'];
type ContractPage = components['schemas']['PlaybookPage'];
type ContractValidation = components['schemas']['ValidationResult'];
type ContractRun = components['schemas']['PlaybookRun'];
type ContractRunPage = components['schemas']['PlaybookRunPage'];
type ContractArtifact = components['schemas']['Artifact'];
type ContractArtifactPreview = components['schemas']['ArtifactPreview'];

export function createResourcePlaybookCrudGateway(
  options: { backendSrv?: BackendSrv; resourceClient?: ResourceClient; folderUid?: string } = {}
): PlaybookCrudGateway {
  let resources: ResourceClient | undefined;
  const client = () =>
    (resources ??= options.resourceClient ?? new ResourceClient(options.backendSrv ?? getBackendSrv()));
  const folderHeaders = () => ({ 'X-Aegis-Folder-UID': requireFolder(options.folderUid) });
  return {
    withFolder(folderUid) {
      return createResourcePlaybookCrudGateway({ ...options, resourceClient: client(), folderUid });
    },
    async listPlaybooks(signal) {
      const items: PlaybookSummary[] = [];
      let cursor = '';
      do {
        const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
        const page = await client().request(`/api/v1/playbooks${query}`, isPlaybookPage, { headers: folderHeaders(), signal });
        items.push(...page.items.map((item) => toSummary(item, requireFolder(options.folderUid))));
        cursor = page.has_more ? page.next_cursor ?? '' : '';
        if (page.has_more && !cursor) {
          throw new ResourceClientError(502, 'provider_unavailable', 'Playbook 分页响应缺少 next_cursor。');
        }
      } while (cursor);
      return items;
    },
    async getPlaybook(id, signal) {
      return toDocument(await client().request(playbookPath(id), isPlaybook, { headers: folderHeaders(), signal }), requireFolder(options.folderUid));
    },
    async createPlaybook(input, signal) {
      requireNativeSource(input.source);
      return toDocument(
        await client().request('/api/v1/playbooks', isPlaybook, {
          method: 'POST',
          data: input.source,
          headers: { ...folderHeaders(), 'Content-Type': 'application/yaml', 'Idempotency-Key': input.idempotencyKey },
          signal,
        }),
		requireFolder(options.folderUid)
      );
    },
    async updatePlaybook(id, input, signal) {
      requireNativeSource(input.source);
      return toDocument(
        await client().request(playbookPath(id), isPlaybook, {
          method: 'PUT',
          data: input.source,
          headers: { ...folderHeaders(), 'Content-Type': 'application/yaml' },
          signal,
        }),
		requireFolder(options.folderUid)
      );
    },
    async deletePlaybook(id, signal) {
      await client().requestVoid(playbookPath(id), { method: 'DELETE', headers: folderHeaders(), signal });
    },
    async validatePlaybook(source, signal) {
      requireNativeSource(source);
      return client().request('/api/v1/playbooks/validate', isValidationResult, {
        method: 'POST',
        data: source,
        headers: { ...folderHeaders(), 'Content-Type': 'application/yaml' },
        signal,
      });
    },
    async listRuns(playbookId, signal) {
      const items: PlaybookRunRecord[] = [];
      let cursor = '';
      do {
        const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
        const page = await client().request(`${playbookPath(playbookId)}/runs${query}`, isRunPage, { headers: folderHeaders(), signal });
        items.push(...page.items.map(toRun));
        cursor = page.has_more ? page.next_cursor ?? '' : '';
        if (page.has_more && !cursor) {
          throw new ResourceClientError(502, 'provider_unavailable', 'Playbook Run 分页响应缺少 next_cursor。');
        }
      } while (cursor);
      return items;
    },
    async startRun(playbookId, input, signal) {
      return toRun(
        await client().request(`${playbookPath(playbookId)}/runs`, isRun, {
          method: 'POST',
          data: { parameters: input.parameters ?? {} },
          headers: { ...folderHeaders(), 'Idempotency-Key': input.idempotencyKey },
          signal,
        })
      );
    },
    async getRun(runId, signal) {
      return toRun(await client().request(runPath(runId), isRun, { headers: folderHeaders(), signal }));
    },
    async cancelRun(runId, signal) {
      await client().requestVoid(`${runPath(runId)}:cancel`, { method: 'POST', headers: folderHeaders(), signal });
    },
    async retryRun(runId, idempotencyKey, signal) {
      return toRun(await client().request(`${runPath(runId)}:retry`, isRun, {
        method: 'POST',
        headers: { ...folderHeaders(), 'Idempotency-Key': idempotencyKey },
        signal,
      }));
    },
    streamRun(runId, afterSequence, signal) {
      return streamRunEvents(clientBackend(), runId, afterSequence, signal, options.folderUid, async () =>
        toRun(await client().request(runPath(runId), isRun, { headers: folderHeaders(), signal }))
      );
    },
    async completeHumanTask(runId, stepId, input, idempotencyKey, signal) {
      await client().requestVoid(`${runPath(runId)}/human-tasks/${encodeURIComponent(stepId)}:complete`, {
        method: 'POST', data: input, headers: { ...folderHeaders(), 'Idempotency-Key': idempotencyKey }, signal,
      });
    },
    async resolveApproval(runId, stepId, decision, inputs, idempotencyKey, signal) {
      await client().requestVoid(`${runPath(runId)}/approvals/${encodeURIComponent(stepId)}:resolve`, {
        method: 'POST', data: { decision, inputs }, headers: { ...folderHeaders(), 'Idempotency-Key': idempotencyKey }, signal,
      });
    },
    async listArtifacts(runId, signal) {
      const value = await client().request(`${runPath(runId)}/artifacts`, isArtifactPage, { headers: folderHeaders(), signal });
      return value.items.map(toArtifact);
    },
    async previewArtifact(runId, path, signal) {
      const query = `?path=${encodeURIComponent(path)}`;
      return toArtifactPreview(await client().request(`${runPath(runId)}/artifacts/preview${query}`, isArtifactPreview, { headers: folderHeaders(), signal }));
    },
    artifactDownloadUrl(runId, path) {
      return `${PLUGIN_RESOURCE_BASE_URL}${runPath(runId)}/artifacts/download?path=${encodeURIComponent(path)}&folder_uid=${encodeURIComponent(requireFolder(options.folderUid))}`;
    },
  };

  function clientBackend() {
    return options.backendSrv ?? getBackendSrv();
  }
}

function requireNativeSource(source: string) {
  if (!source.trim()) {
    throw new ResourceClientError(400, 'invalid_argument', '请输入原生 Dagu YAML。');
  }
}

function requireFolder(folderUid: string | undefined): string {
  if (!folderUid?.trim()) {
    throw new ResourceClientError(0, 'invalid_argument', '必须选择 Folder。');
  }
  return folderUid;
}

function toSummary(value: ContractSummary, expectedFolderUid: string): PlaybookSummary {
  if (value.folder_uid !== expectedFolderUid) {
    throw new ResourceClientError(502, 'provider_unavailable', 'Playbook Folder ownership 响应不一致。');
  }
  return { id: value.id, folderUid: value.folder_uid, name: value.name, description: value.description, status: value.status };
}

function toDocument(value: ContractPlaybook, expectedFolderUid: string): PlaybookDocument {
  return { ...toSummary(value, expectedFolderUid), source: value.source };
}

function toRun(value: ContractRun): PlaybookRunRecord {
  return {
    id: value.id,
    playbookId: value.playbook_id,
    status: value.status,
    startedAt: value.started_at,
    updatedAt: value.updated_at,
    endedAt: value.ended_at,
    steps: (value.steps ?? []).map((step) => ({
      id: step.id,
      name: step.name,
      status: step.status,
      startedAt: step.started_at,
      endedAt: step.ended_at,
      humanTask: step.human_task,
      approval: step.approval,
    })),
  };
}

function toArtifact(value: ContractArtifact): PlaybookArtifact {
  return { name: value.name, path: value.path, mediaType: value.media_type, size: value.size };
}

function toArtifactPreview(value: ContractArtifactPreview): PlaybookArtifactPreview {
  return { ...toArtifact(value), text: value.text, truncated: value.truncated };
}

function isPlaybook(value: unknown): value is ContractPlaybook {
  const item = record(value);
  return Boolean(
    item &&
      typeof item.id === 'string' &&
      typeof item.name === 'string' &&
      typeof item.description === 'string' &&
      typeof item.status === 'string' &&
      typeof item.source === 'string'
  );
}

function isSummary(value: unknown): value is ContractSummary {
  const item = record(value);
  return Boolean(
    item &&
      typeof item.id === 'string' &&
      typeof item.name === 'string' &&
      typeof item.description === 'string' &&
      typeof item.status === 'string'
  );
}

function isPlaybookPage(value: unknown): value is ContractPage {
  const page = record(value);
  return Boolean(page && Array.isArray(page.items) && page.items.every(isSummary) && typeof page.has_more === 'boolean');
}

function isValidationResult(value: unknown): value is ContractValidation {
  const result = record(value);
  return Boolean(
    result &&
      typeof result.valid === 'boolean' &&
      Array.isArray(result.errors) &&
      result.errors.every((item) => typeof record(item)?.message === 'string')
  );
}

function isRun(value: unknown): value is ContractRun {
  const run = record(value);
  return Boolean(
    run &&
      typeof run.id === 'string' &&
      typeof run.playbook_id === 'string' &&
      isRunStatus(run.status) &&
      typeof run.started_at === 'string' &&
      typeof run.updated_at === 'string' &&
      (run.steps === undefined || (Array.isArray(run.steps) && run.steps.every(isRunStep)))
  );
}

function isRunStep(value: unknown): boolean {
  const step = record(value);
  return Boolean(step && typeof step.id === 'string' && typeof step.name === 'string' && isRunStatus(step.status));
}

function isRunPage(value: unknown): value is ContractRunPage {
  const page = record(value);
  return Boolean(page && Array.isArray(page.items) && page.items.every(isRun) && typeof page.has_more === 'boolean');
}

function isArtifactPage(value: unknown): value is { items: ContractArtifact[] } {
  const page = record(value);
  return Boolean(page && Array.isArray(page.items) && page.items.every(isArtifact));
}

function isArtifact(value: unknown): value is ContractArtifact {
  const item = record(value);
  return Boolean(item && typeof item.name === 'string' && typeof item.path === 'string' && typeof item.media_type === 'string' && typeof item.size === 'number');
}

function isArtifactPreview(value: unknown): value is ContractArtifactPreview {
  const item = record(value);
  const raw = item as Record<string, unknown> | undefined;
  return Boolean(raw && isArtifact(raw) && typeof (raw as Record<string, unknown>).text === 'string' && typeof (raw as Record<string, unknown>).truncated === 'boolean');
}

function isRunStatus(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    ['queued', 'running', 'waiting_for_input', 'waiting_for_approval', 'succeeded', 'failed', 'cancelled'].includes(value)
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function playbookPath(id: string) {
  return `/api/v1/playbooks/${encodeURIComponent(id)}`;
}

function runPath(id: string) {
  return `/api/v1/runs/${encodeURIComponent(id)}`;
}

async function* streamRunEvents(
  backend: BackendSrv,
  runId: string,
  afterSequence: number,
  signal: AbortSignal | undefined,
  folderUid: string | undefined,
  readSnapshot: () => Promise<PlaybookRunRecord>
): AsyncGenerator<PlaybookRunRecord> {
  const request: BackendSrvRequest = {
    url: `${PLUGIN_RESOURCE_BASE_URL}/api/v1/runs/${encodeURIComponent(runId)}/events?after_sequence=${afterSequence}`,
    method: 'GET', headers: { 'X-Aegis-Folder-UID': requireFolder(folderUid) }, abortSignal: signal, showErrorAlert: false, validatePath: true,
  };
  const decoder = new SSEDecoder();
  for await (const response of observableValues(backend.chunked(request), signal)) {
    if (response.status < 200 || response.status >= 300) {
      throw new ResourceClientError(response.status, response.status, 'Playbook 事件流请求失败。');
    }
    for (const data of decoder.push(response.data)) {
      const event = JSON.parse(data) as { event_type?: string; payload?: unknown };
      const payload = record(event.payload);
      if (event.event_type !== 'run.updated' || !isRunStatus(payload?.status)) {
        continue;
      }
      // run.updated 只承诺轻量状态；完整 Step/时间信息始终从 Run 快照读取。
      yield await readSnapshot();
    }
  }
  decoder.finish();
}

function observableValues<T>(observable: Observable<T>, signal?: AbortSignal): AsyncIterable<T> {
  const queue: T[] = [];
  let done = false;
  let failure: unknown;
  let wake: (() => void) | undefined;
  const subscription = observable.subscribe({ next: (value) => { queue.push(value); wake?.(); wake = undefined; }, error: (error) => { failure = error; done = true; wake?.(); wake = undefined; }, complete: () => { done = true; wake?.(); wake = undefined; } });
  signal?.addEventListener('abort', () => subscription.unsubscribe(), { once: true });
  return { [Symbol.asyncIterator]: async function* () { try { while (!done || queue.length) { if (!queue.length) {await new Promise<void>((resolve) => { wake = resolve; });} while (queue.length) {yield queue.shift()!;} } if (failure) {throw failure;} } finally { subscription.unsubscribe(); } } };
}

class SSEDecoder {
  private buffer = '';
  private readonly decoder = new TextDecoder();
  push(chunk?: Uint8Array): string[] {
    this.buffer += chunk ? this.decoder.decode(chunk, { stream: true }).replaceAll('\r\n', '\n') : '';
    const events: string[] = [];
    let boundary = this.buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (data) {events.push(data);}
      boundary = this.buffer.indexOf('\n\n');
    }
    return events;
  }
  finish() { this.push(); if (this.buffer.trim()) {throw new ResourceClientError(502, 'provider_unavailable', 'Playbook 事件流以不完整事件结束。');} }
}
