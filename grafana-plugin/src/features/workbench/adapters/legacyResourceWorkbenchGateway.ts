// 迁移前的 Workbench 契约适配器，仅在兼容窗口内保留用于比对和回退，不参与真实模式装配。
import { BackendSrv, BackendSrvRequest, getBackendSrv, isFetchError } from '@grafana/runtime';
import { Observable } from 'rxjs';
import {
  AgentEvent as ContractAgentEvent,
  Chart,
  ChartPayload,
  GetSessionResponse,
  Message,
  Query,
  Response as ContractResponse,
  Session,
  ToolCallPayload,
  isAgentEvent,
  isChartPayload,
  isDonePayload,
  isErrorPayload,
  isGetSessionResponse,
  isInterruptPayload,
  isMessageDelta,
  isResponse,
  isSession,
  isToolCallPayload,
  isToolResultPayload,
} from '../../../api/generated/pluginBackend';
import { Folder } from '../../../app/model';
import { ResourceClient } from '../../../adapters/resourcesdk/resourceClient';
import { PLUGIN_RESOURCE_BASE_URL } from '../../../constants';
import {
  AgentEvent,
  CanvasLayout,
  CanvasPreview,
  OpenedSession,
  PendingHITL,
  ResourceRequestError,
  ResolveInterruptInput,
  SavedChartPreview,
  SendMessageInput,
  SessionSummary,
  ToolCall,
  WorkbenchContext,
  WorkbenchMessage,
} from '../model';
import { WorkbenchGateway } from '../ports/WorkbenchGateway';

const sessionsPath = '/api/v1/sessions';
const chatPath = '/api/v1/chat';
const chatResumePath = '/api/v1/chat/resume';
const maxErrorResponseBytes = 64 * 1024;

export interface ResourceWorkbenchGatewayOptions {
  backendSrv?: BackendSrv;
  resourceClient?: ResourceClient;
}

/**
 * 把真实 Session 聚合和 Agent SSE 转换成 Workbench 的视图模型。
 * 浏览器只调用 Grafana Resource API，不知道 AI Core 地址、服务间配置或可信身份头。
 */
export function createResourceWorkbenchGateway(options: ResourceWorkbenchGatewayOptions = {}): WorkbenchGateway {
  // 延迟读取 Grafana runtime，避免未使用 Workbench 的页面仅创建 Provider 就触发后端依赖。
  let resolvedBackendSrv: BackendSrv | undefined;
  let resolvedResourceClient: ResourceClient | undefined;
  const backendSrv = () => (resolvedBackendSrv ??= options.backendSrv ?? getBackendSrv());
  const resources = () => (resolvedResourceClient ??= options.resourceClient ?? new ResourceClient(backendSrv()));

  return {
    async listSessions(signal?: AbortSignal) {
      const sessions = await resources().request(sessionsPath, isSessionList, { signal });
      return sessions.map((session) => toSessionSummary(session));
    },

    async openSession(sessionId: string, signal?: AbortSignal) {
      const detail = await resources().request(sessionPath(sessionId), isGetSessionResponse, { signal });
      return toOpenedSession(detail);
    },

    async createSession(input, signal?: AbortSignal) {
      // Folder 权限尚未进入这条纵向链路，暂不把 UI 建议写成可信 Session 绑定。
      const created = await resources().request(sessionsPath, isSession, {
        method: 'POST',
        data: { title: input.title.trim() },
        signal,
      });
      return emptyOpenedSession(created);
    },

    async archiveSession(sessionId: string, signal?: AbortSignal) {
      const detail = await resources().request(sessionPath(sessionId), isGetSessionResponse, { signal });
      const archived = await resources().request(sessionPath(sessionId), isSession, {
        method: 'PUT',
        data: {
          title: detail.session.title,
          status: 'archived',
          version: detail.session.version,
        },
        signal,
      });
      return toSessionSummary(archived, lastUserMessage(detail));
    },

    async deleteSession(sessionId: string, signal?: AbortSignal) {
      await resources().request(sessionPath(sessionId), isUndefined, {
        method: 'DELETE',
        signal,
      });
    },

    async getContext(folderUid: string, signal?: AbortSignal) {
      throwIfAborted(signal);
      return emptyContext(folderUid);
    },

    streamMessage(input: SendMessageInput, signal: AbortSignal) {
      return streamMessage(backendSrv(), input, signal);
    },

    async cancelTurn(sessionId, turnId, idempotencyKey, signal) {
      await resources().request(`${sessionPath(sessionId)}/turns/${encodeURIComponent(turnId)}:cancel`, isUndefined, {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        signal,
      });
    },

    resolveInterrupt(input, signal: AbortSignal) {
      return streamResume(backendSrv(), input, signal);
    },

  };
}

function streamMessage(
  backendSrv: BackendSrv,
  input: SendMessageInput,
  signal: AbortSignal
): AsyncGenerator<AgentEvent> {
  return streamAgentEvents(
    backendSrv,
    {
      url: `${PLUGIN_RESOURCE_BASE_URL}${chatPath}`,
      method: 'POST',
      data: {
        client_turn_id: input.clientTurnId,
        session_id: input.sessionId,
        message: input.input,
        analysis_scope: { datasource_uids: [] },
        context: { mentions: input.mentions },
      },
      abortSignal: signal,
      showErrorAlert: false,
      validatePath: true,
    },
    input.clientTurnId,
    signal
  );
}

function streamResume(
  backendSrv: BackendSrv,
  input: ResolveInterruptInput,
  signal: AbortSignal
): AsyncGenerator<AgentEvent> {
  return streamAgentEvents(
    backendSrv,
    {
      url: `${PLUGIN_RESOURCE_BASE_URL}${chatResumePath}`,
      method: 'POST',
      data: {
        session_id: input.sessionId,
        client_turn_id: input.request.clientTurnId,
        checkpoint_id: input.request.id,
        decision: input.decision,
        ...(input.feedback ? { reason: input.feedback } : {}),
      },
      abortSignal: signal,
      showErrorAlert: false,
      validatePath: true,
    },
    input.request.clientTurnId,
    signal
  );
}

async function* streamAgentEvents(
  backendSrv: BackendSrv,
  request: BackendSrvRequest,
  clientTurnId: string,
  signal: AbortSignal
): AsyncGenerator<AgentEvent> {
  throwIfAborted(signal);
  const decoder = new SSEDecoder();
  const state: EventMappingState = {};
  let errorResponse: BufferedErrorResponse | undefined;

  yield { type: 'message_start' };

  try {
    for await (const response of observableValues(backendSrv.chunked(request), signal)) {
      if (errorResponse || response.status < 200 || response.status >= 300) {
        errorResponse ??= {
          status: response.status,
          statusText: response.statusText,
          chunks: [],
          byteLength: 0,
        };
        appendErrorChunk(errorResponse, response.data);
        continue;
      }
      if (!response.data || response.data.byteLength === 0) {
        continue;
      }
      for (const data of decoder.push(response.data)) {
        if (data === '[DONE]') {
          continue;
        }
        for (const event of mapContractEvent(parseContractEvent(data), state, clientTurnId)) {
          yield event;
        }
      }
    }
    if (errorResponse) {
      const envelope = decodeBufferedErrorEnvelope(errorResponse);
      throw new ResourceRequestError(
        errorResponse.status,
        envelope?.code ?? errorResponse.status,
        envelope?.message || errorResponse.statusText || '流式请求失败。'
      );
    }
    for (const data of decoder.finish()) {
      if (data === '[DONE]') {
        continue;
      }
      for (const event of mapContractEvent(parseContractEvent(data), state, clientTurnId)) {
        yield event;
      }
    }
  } catch (error) {
    throw mapStreamError(error);
  }

  // done、error 与 interrupt 都是公共契约定义的合法终态；连接关闭本身不能替代终态事件。
  if (!state.terminal) {
    throw new ResourceRequestError(200, 1007, 'Agent 流在终态事件前中断。');
  }
}

interface BufferedErrorResponse {
  status: number;
  statusText: string;
  chunks: Uint8Array[];
  byteLength: number;
}

function appendErrorChunk(response: BufferedErrorResponse, chunk: Uint8Array | undefined) {
  if (!chunk || chunk.byteLength === 0) {
    return;
  }
  const nextSize = response.byteLength + chunk.byteLength;
  if (nextSize > maxErrorResponseBytes) {
    // 错误正文不参与正常 SSE 解码；限制缓冲大小，避免异常上游持续占用浏览器内存。
    throw new ResourceRequestError(response.status, response.status, '流式错误响应超过 64 KiB 上限。');
  }
  response.chunks.push(chunk.slice());
  response.byteLength = nextSize;
}

function decodeBufferedErrorEnvelope(response: BufferedErrorResponse): ContractResponse | undefined {
  const body = new Uint8Array(response.byteLength);
  let offset = 0;
  for (const chunk of response.chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return decodeErrorEnvelope(body);
}

interface EventMappingState {
  lastToolCallId?: string;
  messageEnded?: boolean;
  terminal?: boolean;
}

function mapContractEvent(event: ContractAgentEvent, state: EventMappingState, clientTurnId: string): AgentEvent[] {
  switch (event.type) {
    case 'message':
      if (!isMessageDelta(event.payload)) {
        throw invalidEvent('message');
      }
      return [{ type: 'message_delta', payload: { delta: event.payload.delta } }];
    case 'tool_call':
      if (!isToolCallPayload(event.payload)) {
        throw invalidEvent('tool_call');
      }
      state.lastToolCallId = event.payload.call_id;
      return [{ type: 'tool_call', payload: toToolCall(event.payload) }];
    case 'tool_result':
      if (!isToolResultPayload(event.payload)) {
        throw invalidEvent('tool_result');
      }
      return [
        {
          type: 'tool_result',
          payload: {
            id: event.payload.call_id,
            result: displayJSON(event.payload.content),
            status: event.payload.is_error ? 'err' : 'ok',
            durationMs: 0,
          },
        },
      ];
    case 'chart':
    case 'chart_update':
      if (!isChartPayload(event.payload)) {
        throw invalidEvent(event.type);
      }
      return [{ type: 'chart', payload: toSavedChart(event.payload) }];
    case 'interrupt': {
      if (!isInterruptPayload(event.payload)) {
        throw invalidEvent('interrupt');
      }
      state.terminal = true;
      const interrupt: PendingHITL = {
        id: event.payload.checkpoint_id,
        clientTurnId,
        toolCallId: state.lastToolCallId ?? event.payload.checkpoint_id,
        server: 'agent',
        tool: 'approval',
        args: '',
        reason: event.payload.reason,
        preview: previewLines(event.payload.preview),
      };
      return [...endMessage(state), { type: 'interrupt', payload: interrupt }];
    }
    case 'error':
      if (!isErrorPayload(event.payload)) {
        throw invalidEvent('error');
      }
      state.terminal = true;
      return [
        {
          type: 'error',
          payload: {
            code: event.payload.code,
            message: event.payload.message,
            retryable: event.payload.retryable ?? false,
          },
        },
      ];
    case 'done':
      if (!isDonePayload(event.payload)) {
        throw invalidEvent('done');
      }
      state.terminal = true;
      return [
        ...endMessage(state),
        { type: 'done', payload: { turnId: event.payload.turn_id, replayed: event.payload.replayed } },
      ];
    case 'interrupt_resolved':
      return [];
    default:
      throw invalidEvent(String(event.type));
  }
}

function endMessage(state: EventMappingState): AgentEvent[] {
  if (state.messageEnded) {
    return [];
  }
  state.messageEnded = true;
  return [{ type: 'message_end', payload: {} }];
}

function parseContractEvent(data: string): ContractAgentEvent {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw new ResourceRequestError(200, 1007, 'Agent 返回了无效 SSE JSON。');
  }
  if (!isAgentEvent(value)) {
    throw new ResourceRequestError(200, 1007, 'Agent 返回了无效事件结构。');
  }
  return value;
}

function toToolCall(payload: ToolCallPayload): ToolCall {
  const { server, tool } = splitToolName(payload.name);
  return {
    id: payload.call_id,
    server,
    tool,
    tier: readTool(payload.name) ? 'read' : 'execute',
    args: JSON.stringify(payload.arguments, null, 2),
    status: 'pending',
  };
}

function toSavedChart(payload: ChartPayload): SavedChartPreview {
  return {
    id: payload.chart.id,
    title: payload.chart.title,
    description: payload.chart.description ?? '',
    visualization: chartType(payload.chart.type),
    renderMode: 'definition',
    // Chart.spec 是当前公共契约中的 VizConfig 兼容读取表示；查询单独由 Query 保存。
    vizConfig: payload.chart.spec,
    query: payload.query,
  };
}

function toOpenedSession(detail: GetSessionResponse): OpenedSession {
  const queries = new Map(detail.queries.map(({ current }) => [current.id, current]));
  const chartDefinitions = new Map(
    detail.charts.map(({ chart }) => [chart.id, restoredChart(chart, queries.get(chart.query_id))])
  );
  const orderedCharts = detail.canvas.charts
    .slice()
    .sort((left, right) => left.y - right.y || left.x - right.x)
    .map(({ chart_id }) => chartDefinitions.get(chart_id))
    .filter((chart): chart is SavedChartPreview => chart !== undefined);
  for (const chart of chartDefinitions.values()) {
    if (!orderedCharts.some(({ id }) => id === chart.id)) {
      orderedCharts.push(chart);
    }
  }

  const messages: WorkbenchMessage[] = [];
  for (const turn of detail.turns) {
    messages.push(toWorkbenchMessage(turn.user_message, turn.client_turn_id));
    const toolMessage = toToolMessage(turn.assistant_message, turn.client_turn_id);
    if (toolMessage) {
      messages.push(toolMessage);
    }
    const assistant = toWorkbenchMessage(turn.assistant_message, turn.client_turn_id);
    assistant.charts = (turn.charts ?? [])
      .map(({ id }) => chartDefinitions.get(id))
      .filter((chart): chart is SavedChartPreview => chart !== undefined);
    assistant.streamStatus = 'complete';
    messages.push(assistant);
  }

  return {
    // Session.message_count counts persisted user/assistant messages. Tool
    // cards are a UI projection and must not inflate the server summary.
    session: toSessionSummary(detail.session, lastUserMessage(detail), detailMessageCount(detail)),
    messages,
    canvas: {
      visible: true,
      layout: canvasLayout(detail.canvas.layout),
      charts: orderedCharts,
    },
  };
}

function toToolMessage(message: Message, clientTurnId: string): WorkbenchMessage | undefined {
  if (!message.tool_calls || message.tool_calls.length === 0) {
    return undefined;
  }
  const results = new Map((message.tool_results ?? []).map((result) => [result.call_id, result]));
  return {
    id: `message-${message.id}-tools`,
    clientTurnId,
    role: 'tool',
    content: '',
    toolCalls: message.tool_calls.map((call) => {
      const result = results.get(call.call_id);
      const { server, tool } = splitToolName(call.name);
      return {
        id: call.call_id,
        server,
        tool,
        tier: readTool(call.name) ? 'read' : 'execute',
        args: JSON.stringify(call.arguments, null, 2),
        result: result ? displayJSON(result.content) : undefined,
        status: result ? (result.is_error ? 'err' : 'ok') : 'pending',
        durationMs: result ? 0 : undefined,
      };
    }),
  };
}

function toWorkbenchMessage(message: Message, clientTurnId: string): WorkbenchMessage {
  return {
    id: message.id,
    clientTurnId,
    role: message.role === 'user' ? 'user' : 'assistant',
    content: message.content,
  };
}

function restoredChart(chart: Chart, query?: Query): SavedChartPreview {
  return {
    id: chart.id,
    title: chart.title,
    description: chart.description ?? '',
    visualization: chartType(chart.type),
    renderMode: 'definition',
    vizConfig: chart.spec,
    query,
  };
}

function detailMessageCount(detail: GetSessionResponse): number {
  return detail.session.message_count ?? detail.turns.length * 2;
}

function canvasLayout(value: string): CanvasLayout {
  switch (value) {
    case 'grid-3x2':
    case 'flex':
    case 'grid-2x2':
      return value;
    default:
      throw new ResourceRequestError(200, 1007, 'Session 返回了不支持的 Canvas layout。');
  }
}

function emptyOpenedSession(session: Session): OpenedSession {
  return {
    session: toSessionSummary(session),
    messages: [],
    canvas: { visible: true, layout: 'grid-2x2', charts: [] },
  };
}

function toSessionSummary(session: Session, preview = '', messageCount?: number): SessionSummary {
  const folderUid = session.active_folder_uid ?? '';
  return {
    id: session.id,
    title: session.title,
    folderUid,
    folderTitle: folderUid || '未绑定',
    status: session.status === 'archived' ? 'archived' : 'active',
    visibility: session.visibility === 'team' ? 'team' : 'private',
    forkedFrom: session.forked_from,
    updatedAt: session.updated_at,
    messageCount: messageCount ?? session.message_count ?? 0,
    preview,
  };
}

function lastUserMessage(detail: GetSessionResponse): string {
  return detail.turns.at(-1)?.user_message.content ?? '';
}

function emptyContext(folderUid: string): WorkbenchContext {
  const activeFolder: Folder = {
    uid: folderUid,
    title: folderUid || '未绑定',
    permission: 'View',
    serviceCount: 0,
  };
  return {
    activeFolder,
    sharedFolder: { uid: 'shared', title: 'Shared', permission: 'View', serviceCount: 0 },
    injectedServices: [],
    skills: [],
    recent: [],
    cost: {
      llmCalls: 0,
      toolRounds: 0,
      maxToolRounds: 0,
      tokensIn: '—',
      tokensOut: '—',
      latency: '—',
    },
  };
}

class SSEDecoder {
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private dataLines: string[] = [];

  push(chunk: Uint8Array): string[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    return this.drain(false);
  }

  finish(): string[] {
    this.buffer += this.decoder.decode();
    return this.drain(true);
  }

  private drain(final: boolean): string[] {
    const events: string[] = [];
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const rawLine = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.consumeLine(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine, events);
      newline = this.buffer.indexOf('\n');
    }
    if (final && this.buffer.length > 0) {
      this.consumeLine(this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer, events);
      this.buffer = '';
    }
    if (final && this.dataLines.length > 0) {
      events.push(this.dataLines.join('\n'));
      this.dataLines = [];
    }
    return events;
  }

  private consumeLine(line: string, events: string[]) {
    if (line === '') {
      if (this.dataLines.length > 0) {
        events.push(this.dataLines.join('\n'));
        this.dataLines = [];
      }
      return;
    }
    if (line.startsWith(':') || !line.startsWith('data:')) {
      return;
    }
    const data = line.slice(5);
    this.dataLines.push(data.startsWith(' ') ? data.slice(1) : data);
  }
}

async function* observableValues<T>(observable: Observable<T>, signal: AbortSignal): AsyncGenerator<T> {
  throwIfAborted(signal);
  type Item = { value: T } | { error: unknown } | { done: true };
  const items: Item[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const enqueue = (item: Item) => {
    if (closed) {
      return;
    }
    items.push(item);
    wake?.();
    wake = undefined;
  };
  const subscription = observable.subscribe({
    next: (value) => enqueue({ value }),
    error: (error) => enqueue({ error }),
    complete: () => enqueue({ done: true }),
  });
  const onAbort = () => {
    subscription.unsubscribe();
    enqueue({ error: abortError() });
  };
  signal.addEventListener('abort', onAbort, { once: true });

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
        continue;
      }
      if ('error' in item) {
        throw item.error;
      }
      return;
    }
  } finally {
    closed = true;
    signal.removeEventListener('abort', onAbort);
    subscription.unsubscribe();
  }
}

function mapStreamError(error: unknown): Error {
  if (error instanceof ResourceRequestError || (error instanceof DOMException && error.name === 'AbortError')) {
    return error;
  }
  if (isFetchError<unknown>(error)) {
    if (error.cancelled) {
      return abortError();
    }
    const envelope = decodeErrorEnvelope(error.data);
    return new ResourceRequestError(
      error.status,
      envelope?.code ?? 0,
      envelope?.message || error.message || error.statusText || '流式请求失败。'
    );
  }
  return error instanceof Error ? error : new Error('流式请求失败。');
}

function decodeErrorEnvelope(value: unknown): ContractResponse | undefined {
  if (isResponse(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    try {
      const parsed: unknown = JSON.parse(new TextDecoder().decode(value));
      return isResponse(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function sessionPath(sessionId: string): string {
  return `${sessionsPath}/${encodeURIComponent(sessionId)}`;
}

function isUndefined(value: unknown): value is undefined {
  return value === undefined;
}

function isSessionList(value: unknown): value is Session[] {
  return Array.isArray(value) && value.every(isSession);
}

function chartType(value: string): SavedChartPreview['visualization'] {
  switch (value) {
    case 'stat':
    case 'gauge':
    case 'bar':
      return value;
    default:
      return 'line';
  }
}

function splitToolName(name: string): { server: string; tool: string } {
  const separator = Math.max(name.lastIndexOf('.'), name.lastIndexOf('/'));
  if (separator < 0) {
    return { server: 'agent', tool: name };
  }
  return { server: name.slice(0, separator), tool: name.slice(separator + 1) };
}

function readTool(name: string): boolean {
  return /(?:query|search|inspect|list|get|read|find|discover)/i.test(name);
}

function displayJSON(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function previewLines(value: unknown): string[] {
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value;
  }
  const rendered = displayJSON(value);
  return rendered ? rendered.split('\n') : [];
}

function invalidEvent(type: string): ResourceRequestError {
  return new ResourceRequestError(200, 1007, `Agent ${type} 事件载荷无效。`);
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw abortError();
  }
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}
