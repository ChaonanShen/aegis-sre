import { BackendSrv, BackendSrvRequest, getBackendSrv, isFetchError } from '@grafana/runtime';
import { Observable } from 'rxjs';
import type { components } from '../../../api/generated/controlPlane';
import type { AegisEvent } from '../../../api/generated/events';
import { ResourceClient, ResourceClientError } from '../../../adapters/resourcesdk/resourceClient';
import { PLUGIN_RESOURCE_BASE_URL } from '../../../constants';
import {
  AgentEvent,
  OpenedSession,
  PendingHITL,
  ResourceRequestError,
  SessionSummary,
  WorkbenchContext,
  WorkbenchMessage,
} from '../model';
import { WorkbenchGateway } from '../ports/WorkbenchGateway';

type ContractSession = components['schemas']['Session'];
type ContractSessionDetail = components['schemas']['SessionDetail'];
type ContractSessionPage = components['schemas']['SessionPage'];
type ContractMessage = components['schemas']['Message'];
type ContractCanvasProjection = components['schemas']['CanvasProjection'];
type Problem = components['schemas']['Problem'];

const sessionsPath = '/api/v1/sessions';
const canvasPath = (sessionId: string) => `${sessionsPath}/${encodeURIComponent(sessionId)}/canvas`;
const maxErrorResponseBytes = 64 * 1024;

export interface ResourceWorkbenchGatewayOptions {
  backendSrv?: BackendSrv;
  resourceClient?: ResourceClient;
}

/** 将冻结后的 Control Plane v1 契约适配成现有 Workbench 视图模型。 */
export function createResourceWorkbenchGateway(options: ResourceWorkbenchGatewayOptions = {}): WorkbenchGateway {
  let resolvedBackendSrv: BackendSrv | undefined;
  let resolvedResourceClient: ResourceClient | undefined;
  const backendSrv = () => (resolvedBackendSrv ??= options.backendSrv ?? getBackendSrv());
  const resources = () => (resolvedResourceClient ??= options.resourceClient ?? new ResourceClient(backendSrv()));

  return {
    async listSessions(signal) {
      const items: SessionSummary[] = [];
      let cursor = '';
      do {
        const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
        const page = await resources().request(`${sessionsPath}${query}`, isSessionPage, { signal });
        items.push(...page.items.map((session) => toSessionSummary(session)));
        cursor = page.has_more ? page.next_cursor ?? '' : '';
        if (page.has_more && !cursor) {
          throw new ResourceClientError(502, 'provider_unavailable', '会话分页响应缺少 next_cursor。');
        }
      } while (cursor);
      return items;
    },
    async openSession(sessionId, signal) {
      const [detail, canvas] = await Promise.all([
        resources().request(sessionPath(sessionId), isSessionDetail, { signal }),
        resources().request(canvasPath(sessionId), isCanvasProjection, { signal }),
      ]);
      return toOpenedSession(detail, canvas);
    },
    async createSession(input, signal) {
      const session = await resources().request(sessionsPath, isSession, {
        method: 'POST',
        data: { title: input.title.trim() },
        headers: { 'Idempotency-Key': newIdempotencyKey('session') },
        signal,
      });
      return emptyOpenedSession(session);
    },
    async renameSession(sessionId, title, signal) {
      const session = await resources().request(sessionPath(sessionId), isSession, {
        method: 'PATCH',
        data: { title: title.trim() },
        signal,
      });
      return toSessionSummary(session);
    },
    async archiveSession(sessionId, signal) {
      const session = await resources().request(sessionPath(sessionId), isSession, {
        method: 'PATCH',
        data: { status: 'archived' },
        signal,
      });
      return toSessionSummary(session);
    },
    async deleteSession(sessionId, signal) {
      await resources().requestVoid(sessionPath(sessionId), { method: 'DELETE', signal });
    },
    async updateCanvas(sessionId, canvas, signal) {
      const projection = await resources().request(canvasPath(sessionId), isCanvasProjection, {
        method: 'PUT',
        data: {
          visible: canvas.visible,
          layout: canvas.layout,
          active_chart_id: canvas.activeChartId ?? null,
          ordered_chart_ids: canvas.charts.map((chart) => chart.id),
        },
        headers: { 'If-Match': `"canvas:${canvas.revision ?? 0}"` },
        signal,
      });
      return toCanvasPreview(projection);
    },
    async getCanvas(sessionId, signal) {
      const projection = await resources().request(canvasPath(sessionId), isCanvasProjection, { signal });
      return toCanvasPreview(projection);
    },
    async getContext(folderUid, signal) {
      throwIfAborted(signal);
      return emptyContext(folderUid);
    },
    streamMessage(input, signal) {
      return streamEvents(
        backendSrv(),
        `${sessionPath(input.sessionId)}/turns:stream`,
        { message: input.input, mentions: input.mentions },
        input.clientTurnId,
        signal,
        input.activeFolder?.uid
      );
    },
    async cancelTurn(sessionId, turnId, idempotencyKey, signal) {
      await resources().requestVoid(`${sessionPath(sessionId)}/turns/${encodeURIComponent(turnId)}:cancel`, {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        signal,
      });
    },
    resolveInterrupt(input, signal) {
      return streamEvents(
        backendSrv(),
        `${sessionPath(input.sessionId)}/approvals/${encodeURIComponent(input.request.id)}:resolve`,
        { decision: input.decision, ...(input.feedback ? { reason: input.feedback } : {}) },
        input.request.clientTurnId,
        signal,
        input.activeFolder?.uid
      );
    },
  };
}

async function* streamEvents(
  backendSrv: BackendSrv,
  path: string,
  data: unknown,
  idempotencyKey: string,
  signal: AbortSignal,
  folderUid?: string
): AsyncGenerator<AgentEvent> {
  throwIfAborted(signal);
  const request: BackendSrvRequest = {
    url: `${PLUGIN_RESOURCE_BASE_URL}${path}`,
    method: 'POST',
    data,
    headers: {
      'Idempotency-Key': idempotencyKey,
      ...(folderUid ? { 'X-Aegis-Folder-UID': folderUid } : {}),
    },
    abortSignal: signal,
    showErrorAlert: false,
    validatePath: true,
  };
  const decoder = new SSEDecoder();
  let terminal = false;
  let messageEnded = false;
  let bufferedError: BufferedError | undefined;
  let lastToolCallID: string | undefined;
  yield { type: 'message_start' };

  try {
    for await (const response of observableValues(backendSrv.chunked(request), signal)) {
      if (bufferedError || response.status < 200 || response.status >= 300) {
        bufferedError ??= { status: response.status, statusText: response.statusText, chunks: [], size: 0 };
        appendErrorChunk(bufferedError, response.data);
        continue;
      }
      for (const raw of decoder.push(response.data)) {
        const event = parseEvent(raw);
        const mapped = mapEvent(event, idempotencyKey, lastToolCallID);
        if (mapped.lastToolCallID) {
          lastToolCallID = mapped.lastToolCallID;
        }
        if (mapped.endMessage && !messageEnded) {
          messageEnded = true;
          yield { type: 'message_end', payload: {} };
        }
        for (const item of mapped.events) {
          yield item;
        }
        terminal = terminal || mapped.terminal === true;
      }
    }
    if (bufferedError) {
      throw problemFrom(bufferedError);
    }
    for (const raw of decoder.finish()) {
      const mapped = mapEvent(parseEvent(raw), idempotencyKey, lastToolCallID);
      if (mapped.endMessage && !messageEnded) {
        messageEnded = true;
        yield { type: 'message_end', payload: {} };
      }
      for (const item of mapped.events) {
        yield item;
      }
      terminal = terminal || mapped.terminal === true;
    }
  } catch (error) {
    throw mapStreamError(error);
  }
  if (!terminal) {
    throw new ResourceRequestError(200, 1007, 'Agent 流在终态事件前中断。');
  }
}

interface EventMapping {
  events: AgentEvent[];
  terminal?: boolean;
  endMessage?: boolean;
  lastToolCallID?: string;
}

function mapEvent(event: AegisEvent, clientTurnId: string, lastToolCallID?: string): EventMapping {
  const payload = asRecord(event.payload) ?? {};
  switch (event.event_type) {
    case 'turn.started':
      return { events: [{ type: 'turn_started', payload: { turnId: event.turn_id ?? '' } }] };
    case 'message.delta':
      return { events: [{ type: 'message_delta', payload: { delta: stringField(payload, 'delta') } }] };
    case 'tool.started': {
      const callID = stringField(payload, 'call_id');
      return {
        lastToolCallID: callID,
        events: [
          {
            type: 'tool_call',
            payload: {
              id: callID,
              server: stringField(payload, 'server'),
              tool: stringField(payload, 'tool'),
              tier: accessField(payload),
              args: JSON.stringify(payload.arguments ?? {}, null, 2),
              status: 'pending',
            },
          },
        ],
      };
    }
    case 'tool.completed':
      return {
        events: [
          {
            type: 'tool_result',
            payload: {
              id: stringField(payload, 'call_id'),
              result: optionalString(payload.summary),
              status: payload.status === 'succeeded' ? 'ok' : 'err',
              durationMs: numberField(payload, 'duration_ms'),
            },
          },
        ],
      };
    case 'approval.requested': {
      const approval: PendingHITL = {
        id: stringField(payload, 'approval_id'),
        clientTurnId,
        toolCallId: lastToolCallID ?? stringField(payload, 'approval_id'),
        server: 'agent',
        tool: stringField(payload, 'action'),
        args: '',
        preview: stringArray(payload.preview),
        reason: stringField(payload, 'reason'),
      };
      return { events: [{ type: 'interrupt', payload: approval }], terminal: true, endMessage: true };
    }
    case 'turn.completed':
      return {
        events: [{ type: 'done', payload: { turnId: event.turn_id ?? '', replayed: false } }],
        terminal: true,
        endMessage: true,
      };
    case 'turn.failed':
      return {
        events: [
          {
            type: 'error',
            payload: {
              code: 1007,
              message: stringField(payload, 'message'),
              retryable: payload.retryable === true,
            },
          },
        ],
        terminal: true,
        endMessage: true,
      };
    case 'approval.resolved':
    case 'artifact.created':
    case 'run.updated':
      return { events: [] };
    case 'canvas.updated':
      return {
        events: [
          {
            type: 'canvas_updated',
            payload: {
              sessionId: event.session_id ?? '',
              chartId: stringField(payload, 'chart_id'),
              operationId: stringField(payload, 'operation_id'),
              revision: numberField(payload, 'revision'),
            },
          },
        ],
      };
    default:
      throw new ResourceRequestError(200, 1007, 'Agent 返回了未知事件类型。');
  }
}

function toOpenedSession(detail: ContractSessionDetail, canvas: ContractCanvasProjection): OpenedSession {
  const messages = (detail.messages ?? []).map(toMessage);
  return {
    session: toSessionSummary(detail.session, messages),
    messages,
    canvas: toCanvasPreview(canvas),
  };
}

function emptyOpenedSession(session: ContractSession): OpenedSession {
  return {
    session: toSessionSummary(session),
    messages: [],
    canvas: { visible: false, layout: 'grid-2x2', charts: [], revision: 0 },
  };
}

function toCanvasPreview(projection: ContractCanvasProjection): OpenedSession['canvas'] {
  return {
    visible: projection.visible,
    layout: projection.layout,
    revision: projection.revision,
    activeChartId: projection.active_chart_id ?? undefined,
    charts: projection.items
      .slice()
      .sort((left, right) => left.position - right.position)
      .map(({ chart }) => ({
        id: chart.id,
        title: chart.title,
        description: chart.description,
        visualization: 'line',
        renderMode: 'definition',
        vizConfig: chart.viz_config,
        query: {
          id: chart.query.id,
          session_id: projection.session_id,
          version: chart.query.version,
          spec: {
            datasource_uid: chart.query.datasource_uid,
            expression: chart.query.expression,
            range: {
              from: chart.query.range.from,
              to: chart.query.range.to,
              step_seconds: chart.query.range.step_seconds,
            },
          },
          created_at: chart.query.created_at,
        },
      })),
  };
}

function toSessionSummary(session: ContractSession, messages: WorkbenchMessage[] = []): SessionSummary {
  const enriched = session as ContractSession & { message_count?: number | null; preview?: string | null };
  const messageCount = enriched.message_count ?? (messages.length ? messages.length : undefined);
  const preview = enriched.preview ?? [...messages].reverse().find(({ role }) => role === 'user')?.content;
  return {
    id: session.id,
    title: session.title,
    // Folder 只属于请求授权上下文，不能从 Provider 会话投影成持久归属。
    folderUid: '',
    folderTitle: '未绑定 Folder',
    status: session.status === 'archived' ? 'archived' : 'active',
    visibility: 'private',
    updatedAt: session.updated_at,
    messageCount,
    preview: preview ?? '',
  };
}

function toMessage(message: ContractMessage): WorkbenchMessage {
  return { id: message.id, role: message.role, content: message.content, streamStatus: 'complete' };
}

function isSession(value: unknown): value is ContractSession {
  const record = asRecord(value);
  return Boolean(
    record &&
    typeof record.id === 'string' &&
    typeof record.title === 'string' &&
    typeof record.status === 'string' &&
    typeof record.created_at === 'string' &&
    typeof record.updated_at === 'string'
  );
}

function isSessionPage(value: unknown): value is ContractSessionPage {
  const record = asRecord(value);
  return Boolean(
    record && Array.isArray(record.items) && record.items.every(isSession) && typeof record.has_more === 'boolean'
  );
}

function isCanvasProjection(value: unknown): value is ContractCanvasProjection {
  const record = asRecord(value);
  return Boolean(
    record &&
    typeof record.session_id === 'string' &&
    typeof record.visible === 'boolean' &&
    typeof record.layout === 'string' &&
    typeof record.revision === 'number' &&
    Array.isArray(record.items)
  );
}

function isSessionDetail(value: unknown): value is ContractSessionDetail {
  const record = asRecord(value);
  return Boolean(record && isSession(record.session) && (record.messages === undefined || isMessages(record.messages)));
}

function isMessages(value: unknown): value is ContractMessage[] {
  return (
    Array.isArray(value) &&
    value.every((message) => {
      const record = asRecord(message);
      return Boolean(
        record &&
        typeof record.id === 'string' &&
        (record.role === 'user' || record.role === 'assistant' || record.role === 'tool') &&
        typeof record.content === 'string' &&
        typeof record.created_at === 'string'
      );
    })
  );
}

function parseEvent(data: string): AegisEvent {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw new ResourceRequestError(200, 1007, 'Agent 返回了无效 SSE JSON。');
  }
  const record = asRecord(value);
  if (
    !record ||
    typeof record.event_id !== 'string' ||
    typeof record.event_type !== 'string' ||
    typeof record.sequence !== 'number' ||
    typeof record.occurred_at !== 'string' ||
    !asRecord(record.payload)
  ) {
    throw new ResourceRequestError(200, 1007, 'Agent 返回了无效事件结构。');
  }
  return value as AegisEvent;
}

class SSEDecoder {
  private buffer = '';
  private readonly textDecoder = new TextDecoder();

  push(chunk?: Uint8Array): string[] {
    if (chunk) {
      this.buffer += this.textDecoder.decode(chunk, { stream: true }).replaceAll('\r\n', '\n');
    }
    return this.drain(false);
  }

  finish(): string[] {
    this.buffer += this.textDecoder.decode();
    return this.drain(true);
  }

  private drain(final: boolean): string[] {
    const events: string[] = [];
    let boundary = this.buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data) {
        events.push(data);
      }
      boundary = this.buffer.indexOf('\n\n');
    }
    if (final && this.buffer.trim()) {
      throw new ResourceRequestError(200, 1007, 'Agent SSE 事件未完整结束。');
    }
    return events;
  }
}

interface BufferedError {
  status: number;
  statusText: string;
  chunks: Uint8Array[];
  size: number;
}

function appendErrorChunk(error: BufferedError, chunk?: Uint8Array) {
  if (!chunk) {
    return;
  }
  if (error.size + chunk.byteLength > maxErrorResponseBytes) {
    throw new ResourceRequestError(error.status, error.status, '流式错误响应超过 64 KiB 上限。');
  }
  error.chunks.push(chunk.slice());
  error.size += chunk.byteLength;
}

function problemFrom(error: BufferedError): ResourceRequestError {
  const body = new Uint8Array(error.size);
  let offset = 0;
  for (const chunk of error.chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(body)) as unknown;
    if (isProblem(value)) {
      return new ResourceRequestError(error.status, 1007, value.detail || value.title);
    }
  } catch {
    // Fall through to the stable transport error below.
  }
  return new ResourceRequestError(error.status, error.status, error.statusText || '流式请求失败。');
}

function isProblem(value: unknown): value is Problem {
  const record = asRecord(value);
  return Boolean(
    record && typeof record.status === 'number' && typeof record.code === 'string' && typeof record.title === 'string'
  );
}

async function* observableValues<T>(observable: Observable<T>, signal: AbortSignal): AsyncGenerator<T> {
  throwIfAborted(signal);
  type Item = { value: T } | { error: unknown } | { done: true };
  const items: Item[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const enqueue = (item: Item) => {
    if (!closed) {
      items.push(item);
      wake?.();
      wake = undefined;
    }
  };
  const subscription = observable.subscribe({
    next: (value) => enqueue({ value }),
    error: (error) => enqueue({ error }),
    complete: () => enqueue({ done: true }),
  });
  const abort = () => {
    subscription.unsubscribe();
    enqueue({ error: new DOMException('The operation was aborted.', 'AbortError') });
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      if (items.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      const item = items.shift();
      if (!item) {
        continue;
      }
      if ('value' in item) {
        yield item.value;
      } else if ('error' in item) {
        throw item.error;
      } else {
        return;
      }
    }
  } finally {
    closed = true;
    signal.removeEventListener('abort', abort);
    subscription.unsubscribe();
  }
}

function mapStreamError(error: unknown): Error {
  if (error instanceof ResourceRequestError || (error instanceof DOMException && error.name === 'AbortError')) {
    return error;
  }
  if (isFetchError<unknown>(error)) {
    if (error.cancelled) {
      return new DOMException('The operation was aborted.', 'AbortError');
    }
    return new ResourceRequestError(error.status, error.status, error.message || error.statusText || '流式请求失败。');
  }
  if (error instanceof ResourceClientError) {
    return new ResourceRequestError(error.status, 1007, error.message);
  }
  return error instanceof Error ? error : new Error('流式请求失败。');
}

function sessionPath(id: string): string {
  return `${sessionsPath}/${encodeURIComponent(id)}`;
}

function newIdempotencyKey(prefix: string): string {
  const suffix = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  return `${prefix}-${suffix}`;
}

function emptyContext(folderUid: string): WorkbenchContext {
  const folder = { uid: folderUid, title: folderUid || '未绑定 Folder', permission: 'View' as const, serviceCount: 0 };
  return {
    activeFolder: folder,
    sharedFolder: folder,
    injectedServices: [],
    skills: [],
    recent: [],
    cost: { llmCalls: 0, toolRounds: 0, maxToolRounds: 0, tokensIn: '—', tokensOut: '—', latency: '—' },
  };
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError');
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(record: Record<string, unknown> | undefined, field: string): string {
  const value = record?.[field];
  if (typeof value !== 'string') {
    throw new ResourceRequestError(200, 1007, `Agent 事件缺少 ${field}。`);
  }
  return value;
}

function numberField(record: Record<string, unknown> | undefined, field: string): number {
  const value = record?.[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function optionalString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function accessField(record: Record<string, unknown> | undefined): 'read' | 'write' | 'execute' {
  return record?.access === 'read' || record?.access === 'write' ? record.access : 'execute';
}
