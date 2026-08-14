import {
  AgentEvent,
  CreateSessionInput,
  OpenedSession,
  ResolveInterruptInput,
  SavedChartPreview,
  SendMessageInput,
} from '../model';
import { WorkbenchGateway } from '../ports/WorkbenchGateway';
import { contextFor, seededSessions } from '../fixtures/workbenchFixtures';

const DEFAULT_STORAGE_KEY = 'torchbearing.fixture.workbench.v3';

export interface FixtureWorkbenchGatewayOptions {
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  storageKey?: string;
  latencyMs?: number;
  streamDelayMs?: number;
  now?: () => Date;
  newId?: () => string;
}

export function createFixtureWorkbenchGateway(options: FixtureWorkbenchGatewayOptions = {}): WorkbenchGateway {
  const storage = options.storage ?? window.sessionStorage;
  const storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;
  const latencyMs = options.latencyMs ?? 100;
  const streamDelayMs = options.streamDelayMs ?? 18;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? createFixtureSessionId;

  const writeSessions = (sessions: OpenedSession[]) => {
    storage.setItem(storageKey, JSON.stringify(sessions));
  };

  const readSessions = (): OpenedSession[] => {
    const persisted = storage.getItem(storageKey);
    if (persisted) {
      try {
        const parsed = JSON.parse(persisted) as unknown;
        if (isOpenedSessionList(parsed)) {
          return parsed;
        }
      } catch {
        // Re-seed malformed fixture storage below.
      }
    }

    const initial = clone(seededSessions);
    writeSessions(initial);
    return initial;
  };

  const findSession = (sessionId: string): OpenedSession => {
    const session = readSessions().find(({ session }) => session.id === sessionId);
    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }
    return session;
  };

  return {
    async listSessions(signal?: AbortSignal) {
      await delay(latencyMs, signal);
      return readSessions()
        .map(({ session }) => clone(session))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },

    async openSession(sessionId: string, signal?: AbortSignal) {
      await delay(latencyMs, signal);
      return clone(findSession(sessionId));
    },

    async createSession(input: CreateSessionInput, signal?: AbortSignal) {
      await delay(latencyMs, signal);
      const created: OpenedSession = {
        session: {
          id: newId(),
          title: input.title.trim(),
          folderUid: input.folder?.uid ?? '',
          folderTitle: input.folder?.title ?? '未绑定',
          status: 'active',
          visibility: 'private',
          updatedAt: now().toISOString(),
          messageCount: 0,
          preview: '新建空白会话',
        },
        messages: [],
        canvas: {
          visible: true,
          layout: 'grid-2x2',
          charts: [],
        },
      };
      writeSessions([created, ...readSessions()]);
      return clone(created);
    },
    async renameSession(sessionId: string, title: string, signal?: AbortSignal) {
      await delay(latencyMs, signal);
      const sessions = readSessions();
      const found = sessions.find(({ session }) => session.id === sessionId);
      if (!found) throw new SessionNotFoundError(sessionId);
      found.session.title = title.trim();
      found.session.updatedAt = now().toISOString();
      writeSessions(sessions);
      return clone(found.session);
    },

    async archiveSession(sessionId: string, signal?: AbortSignal) {
      await delay(latencyMs, signal);
      const sessions = readSessions();
      const index = sessions.findIndex(({ session }) => session.id === sessionId);
      if (index < 0) {
        throw new SessionNotFoundError(sessionId);
      }
      sessions[index].session.status = 'archived';
      sessions[index].session.updatedAt = now().toISOString();
      writeSessions(sessions);
      return clone(sessions[index].session);
    },

    async deleteSession(sessionId: string, signal?: AbortSignal) {
      await delay(latencyMs, signal);
      const sessions = readSessions();
      const remaining = sessions.filter(({ session }) => session.id !== sessionId);
      if (remaining.length === sessions.length) {
        throw new SessionNotFoundError(sessionId);
      }
      writeSessions(remaining);
    },

    async getContext(folderUid: string, signal?: AbortSignal) {
      await delay(latencyMs, signal);
      return clone(contextFor(folderUid));
    },

    streamMessage(input: SendMessageInput, signal: AbortSignal) {
      return streamFixtureReply(input, signal, streamDelayMs);
    },

    async cancelTurn(_sessionId: string, _turnId: string, _idempotencyKey: string, signal?: AbortSignal) {
      await delay(0, signal);
    },

    resolveInterrupt(input: ResolveInterruptInput, signal: AbortSignal) {
      return streamFixtureResolution(input, signal, streamDelayMs);
    },
  };
}

async function* streamFixtureReply(
  input: SendMessageInput,
  signal: AbortSignal,
  streamDelayMs: number
): AsyncGenerator<AgentEvent> {
  const activeFolder = input.activeFolder;
  const route = routeInput(input.input);
  const toolCallId = `tc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const service = input.mentions[0]?.replace(/^@/, '') || 'checkout-api';

  yield { type: 'message_start' };
  yield { type: 'turn_started', payload: { turnId: `turn-${input.clientTurnId}` } };

  if (route === 'switch_folder') {
    const folderUid = input.input.match(/(?:switch-?folder|cd)\s+([\w-]+)/i)?.[1] ?? 'infra';
    yield* emitText(`正在把当前上下文切换到 Folder: ${folderUid}。`, signal, streamDelayMs);
    yield { type: 'folder_changed', payload: { folderUid } };
    yield { type: 'message_end', payload: {} };
    yield doneEvent(input.clientTurnId);
    return;
  }

  if (route === 'write') {
    if (!activeFolder) {
      yield* emitText('当前会话未绑定 Folder，无法确定写入目标。请先选择 Folder 后再发起变更。', signal, streamDelayMs);
      yield { type: 'message_end', payload: {} };
      yield doneEvent(input.clientTurnId);
      return;
    }
    yield* emitText('这个操作会修改 Grafana 资源，需要你确认。\n\n', signal, streamDelayMs);
    const tool = /删除|delete/i.test(input.input)
      ? 'delete_panel'
      : /回滚|rollback/i.test(input.input)
        ? 'rollback_dashboard'
        : /创建|新建|add|create/i.test(input.input)
          ? 'create_dashboard_panel'
          : 'update_dashboard';
    const args = JSON.stringify({
      dashboard: 'checkout-overview',
      folder: activeFolder.title,
      change: 'p95 + p99 compare panel',
    });
    yield {
      type: 'tool_call',
      payload: {
        id: toolCallId,
        server: 'grafana',
        tool,
        tier: 'write',
        args,
        status: 'pending',
      },
    };
    yield {
      type: 'interrupt',
      payload: {
        id: `interrupt-${toolCallId}`,
        clientTurnId: input.clientTurnId,
        toolCallId,
        server: 'grafana',
        tool,
        args,
        reason: '写操作需要用户审批',
        preview: [
          '--- dashboard: checkout-overview',
          '+++ dashboard: checkout-overview',
          '~ panels: 8 → 9',
          '+ panel: checkout p99 latency',
          '+ expr: histogram_quantile(0.99, ...)',
        ],
      },
    };
    return;
  }

  if (route === 'slash') {
    yield* emitText('正在运行 /check-cart，先检查关键依赖。\n\n', signal, streamDelayMs);
    yield toolCall(toolCallId, 'skills', 'check_cart', 'execute', `folder=${activeFolder?.uid ?? 'unbound'}`);
    await delay(streamDelayMs * 3, signal);
    yield toolResult(toolCallId, 'checkout-api 正常；PG 连接池使用率 88%，建议继续观察。', 1680);
    yield* emitText('检查完成：应用指标正常，但 PG 连接池已经接近阈值。', signal, streamDelayMs);
    yield { type: 'message_end', payload: { charts: [chart('下游 PG 连接池', 'gauge')] } };
    yield doneEvent(input.clientTurnId);
    return;
  }

  if (route === 'latency' || route === 'error_rate') {
    yield* emitText(`我先拉一下 ${service} 的数据。\n\n`, signal, streamDelayMs);
    yield toolCall(
      toolCallId,
      'grafana',
      'query_prometheus',
      'read',
      route === 'error_rate'
        ? `sum(rate(http_requests_total{job="${service}",status=~"5.."}[5m]))`
        : `histogram_quantile(0.95, rate(http_request_duration_seconds_bucket{job="${service}"}[5m]))`
    );
    await delay(streamDelayMs * 4, signal);
    yield toolResult(
      toolCallId,
      route === 'error_rate' ? '当前 5xx 错误率: 0.4%（基线 0.1%）' : '本周 p95: 320ms 上周: 280ms diff: +14%',
      route === 'error_rate' ? 740 : 1240
    );
    yield* emitText(
      route === 'error_rate'
        ? '当前错误率为 0.4%，高于 0.1% 基线，峰值出现在 14:18。'
        : '本周 p95 中位数为 320ms，较上周 280ms 上升 14%。建议继续检查下游 PG 连接池。',
      signal,
      streamDelayMs
    );
    yield {
      type: 'message_end',
      payload: {
        charts: [chart(route === 'error_rate' ? '错误率（5xx）' : `${service} p95 latency (7d)`, 'line')],
      },
    };
    yield doneEvent(input.clientTurnId);
    return;
  }

  yield* emitText(
    activeFolder
      ? `当前上下文是 ${activeFolder.title}。你可以 @ 服务、运行 /check-cart，或询问 p95 与错误率。`
      : '当前会话未绑定 Folder。你仍可以描述问题或询问 p95 与错误率；需要限定范围时再选择 Folder。',
    signal,
    streamDelayMs
  );
  yield { type: 'message_end', payload: {} };
  yield doneEvent(input.clientTurnId);
}

async function* streamFixtureResolution(
  input: ResolveInterruptInput,
  signal: AbortSignal,
  streamDelayMs: number
): AsyncGenerator<AgentEvent> {
  const approved = input.decision === 'approved';
  yield {
    type: 'tool_result',
    payload: {
      id: input.request.toolCallId,
      result: approved
        ? `演示审批已通过（未执行真实写操作）${input.feedback ? `：${input.feedback}` : ''}`
        : `演示审批已拒绝：${input.feedback || '未提供原因'}`,
      status: approved ? 'ok' : 'err',
      durationMs: 0,
    },
  };
  yield { type: 'message_start' };
  yield* emitText(
    approved
      ? '审批已通过。本次为演示流程，未执行真实写操作，也未写入审计日志。'
      : '操作已跳过。我保留了当前分析结果，可以继续查询或选择其他方案。',
    signal,
    streamDelayMs
  );
  yield { type: 'message_end', payload: {} };
  yield doneEvent(input.request.clientTurnId);
}

function doneEvent(turnId: string): AgentEvent {
  return { type: 'done', payload: { turnId, replayed: false } };
}

async function* emitText(text: string, signal: AbortSignal, delayMs: number): AsyncGenerator<AgentEvent> {
  for (const character of text) {
    await delay(delayMs, signal);
    yield { type: 'message_delta', payload: { delta: character } };
  }
}

function routeInput(input: string): 'switch_folder' | 'write' | 'slash' | 'error_rate' | 'latency' | 'fallback' {
  const value = input.trim();
  if (/(?:\/)?(?:switch-?folder|cd)\s+[\w-]+/i.test(value)) {
    return 'switch_folder';
  }
  if (/(改|更新|创建|新建|删除|写入|add|create|update|delete|部署|回滚|rollback)/i.test(value)) {
    return 'write';
  }
  if (value.startsWith('/')) {
    return 'slash';
  }
  if (/(错误率|error|5xx|失败率)/i.test(value)) {
    return 'error_rate';
  }
  if (/(latency|延迟|p95|p99|qps|性能|趋势)/i.test(value)) {
    return 'latency';
  }
  return 'fallback';
}

function toolCall(
  id: string,
  server: string,
  tool: string,
  tier: 'read' | 'write' | 'execute',
  args: string
): AgentEvent {
  return { type: 'tool_call', payload: { id, server, tool, tier, args, status: 'pending' } };
}

function toolResult(id: string, result: string, durationMs: number): AgentEvent {
  return { type: 'tool_result', payload: { id, result, durationMs, status: 'ok' } };
}

function chart(title: string, visualization: SavedChartPreview['visualization']): SavedChartPreview {
  return {
    id: `chart-${title.toLocaleLowerCase().replace(/\W+/g, '-')}`,
    title,
    visualization,
    description: `${title} preview`,
    renderMode: 'fixture',
  };
}

function isOpenedSessionList(value: unknown): value is OpenedSession[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        'session' in item &&
        'messages' in item &&
        'canvas' in item &&
        Array.isArray((item as OpenedSession).messages) &&
        Array.isArray((item as OpenedSession).canvas?.charts)
    )
  );
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function delay(durationMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(abortError());
  }
  if (durationMs <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, durationMs);
    const onAbort = () => {
      window.clearTimeout(timeout);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function createFixtureSessionId(): string {
  if (typeof crypto.randomUUID === 'function') {
    return `session-${crypto.randomUUID()}`;
  }
  return `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export class SessionNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super(`Session "${sessionId}" was not found.`);
    this.name = 'SessionNotFoundError';
  }
}
