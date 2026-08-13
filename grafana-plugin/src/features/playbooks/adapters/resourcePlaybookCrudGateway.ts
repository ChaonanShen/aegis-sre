import { BackendSrv, getBackendSrv } from '@grafana/runtime';
import type { components } from '../../../api/generated/controlPlane';
import { ResourceClient, ResourceClientError } from '../../../adapters/resourcesdk/resourceClient';
import { PlaybookDocument, PlaybookRunRecord, PlaybookSummary } from '../crudModel';
import { PlaybookCrudGateway } from '../ports/PlaybookCrudGateway';

type ContractPlaybook = components['schemas']['Playbook'];
type ContractSummary = components['schemas']['PlaybookSummary'];
type ContractPage = components['schemas']['PlaybookPage'];
type ContractValidation = components['schemas']['ValidationResult'];
type ContractRun = components['schemas']['PlaybookRun'];
type ContractRunPage = components['schemas']['PlaybookRunPage'];

export function createResourcePlaybookCrudGateway(
  options: { backendSrv?: BackendSrv; resourceClient?: ResourceClient } = {}
): PlaybookCrudGateway {
  let resources: ResourceClient | undefined;
  const client = () =>
    (resources ??= options.resourceClient ?? new ResourceClient(options.backendSrv ?? getBackendSrv()));
  return {
    async listPlaybooks(signal) {
      const items: PlaybookSummary[] = [];
      let cursor = '';
      do {
        const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
        const page = await client().request(`/api/v1/playbooks${query}`, isPlaybookPage, { signal });
        items.push(...page.items.map(toSummary));
        cursor = page.has_more ? page.next_cursor ?? '' : '';
        if (page.has_more && !cursor) {
          throw new ResourceClientError(502, 'provider_unavailable', 'Playbook 分页响应缺少 next_cursor。');
        }
      } while (cursor);
      return items;
    },
    async getPlaybook(id, signal) {
      return toDocument(await client().request(playbookPath(id), isPlaybook, { signal }));
    },
    async createPlaybook(input, signal) {
      requireNativeSource(input.source);
      return toDocument(
        await client().request('/api/v1/playbooks', isPlaybook, {
          method: 'POST',
          data: input.source,
          headers: { 'Content-Type': 'application/yaml', 'Idempotency-Key': input.idempotencyKey },
          signal,
        })
      );
    },
    async updatePlaybook(id, input, signal) {
      requireNativeSource(input.source);
      return toDocument(
        await client().request(playbookPath(id), isPlaybook, {
          method: 'PUT',
          data: input.source,
          headers: { 'Content-Type': 'application/yaml' },
          signal,
        })
      );
    },
    async deletePlaybook(id, signal) {
      await client().requestVoid(playbookPath(id), { method: 'DELETE', signal });
    },
    async validatePlaybook(source, signal) {
      requireNativeSource(source);
      return client().request('/api/v1/playbooks/validate', isValidationResult, {
        method: 'POST',
        data: source,
        headers: { 'Content-Type': 'application/yaml' },
        signal,
      });
    },
    async listRuns(playbookId, signal) {
      const items: PlaybookRunRecord[] = [];
      let cursor = '';
      do {
        const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
        const page = await client().request(`${playbookPath(playbookId)}/runs${query}`, isRunPage, { signal });
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
          headers: { 'Idempotency-Key': input.idempotencyKey },
          signal,
        })
      );
    },
    async getRun(runId, signal) {
      return toRun(await client().request(runPath(runId), isRun, { signal }));
    },
    async cancelRun(runId, signal) {
      await client().requestVoid(`${runPath(runId)}:cancel`, { method: 'POST', signal });
    },
  };
}

function requireNativeSource(source: string) {
  if (!source.trim()) {
    throw new ResourceClientError(400, 'invalid_argument', '请输入原生 Dagu YAML。');
  }
}

function toSummary(value: ContractSummary): PlaybookSummary {
  return { id: value.id, name: value.name, description: value.description, status: value.status };
}

function toDocument(value: ContractPlaybook): PlaybookDocument {
  return { ...toSummary(value), source: value.source };
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
    })),
  };
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
