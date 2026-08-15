import { AgentEvent, OpenedSession, SavedChartPreview, SavedQuery, ToolCall, WorkbenchMessage } from '../model';

export interface ApplyAgentEventResult {
  session: OpenedSession;
  folderUid?: string;
}

export function applyAgentEvent(
  opened: OpenedSession,
  event: AgentEvent,
  assistantMessageId: string
): ApplyAgentEventResult {
  switch (event.type) {
    case 'message_start':
    case 'turn_started':
    case 'interrupt':
    case 'done':
    case 'canvas_updated':
      return { session: opened };
    case 'message_delta':
      return {
        session: mapMessage(opened, assistantMessageId, (message) => ({
          ...message,
          content: message.content + event.payload.delta,
          streamStatus: 'streaming',
        })),
      };
    case 'message_end': {
      const charts = event.payload.charts ?? [];
      const withMessage = mapMessage(opened, assistantMessageId, (message) => ({
        ...message,
        charts: mergeCharts(message.charts ?? [], charts),
        streamStatus: 'complete',
      }));
      return {
        session: {
          ...withMessage,
          canvas: {
            ...withMessage.canvas,
            charts: mergeCharts(withMessage.canvas.charts, charts),
          },
        },
      };
    }
    case 'chart': {
      const charts = [event.payload];
      const withMessage = mapMessage(opened, assistantMessageId, (message) => ({
        ...message,
        charts: mergeCharts(message.charts ?? [], charts),
      }));
      return {
        session: {
          ...withMessage,
          canvas: {
            ...withMessage.canvas,
            charts: mergeCharts(withMessage.canvas.charts, charts),
          },
        },
      };
    }
    case 'tool_call': {
      const existing = findToolCall(opened.messages, event.payload.id);
      if (existing) {
        return {
          session: withMessages(
            opened,
            opened.messages.map((message) => ({
              ...message,
              toolCalls: message.toolCalls?.map((item) =>
                item.id === event.payload.id ? { ...item, ...event.payload } : item
              ),
            }))
          ),
        };
      }
      const toolMessage: WorkbenchMessage = {
        id: `message-${event.payload.id}`,
        role: 'tool',
        content: '',
        toolCalls: [event.payload],
      };
      const assistantIndex = opened.messages.findIndex(({ id }) => id === assistantMessageId);
      const messages =
        assistantIndex < 0
          ? [...opened.messages, toolMessage]
          : [...opened.messages.slice(0, assistantIndex), toolMessage, ...opened.messages.slice(assistantIndex)];
      return { session: withMessages(opened, messages) };
    }
    case 'tool_result': {
      const toolCall = findToolCall(opened.messages, event.payload.id);
      const chart = event.payload.status === 'ok' ? chartFromPrometheusCall(toolCall, opened.session.id) : undefined;
      const withToolResult = {
        ...opened,
        messages: opened.messages.map((message) => ({
          ...message,
          toolCalls: message.toolCalls?.map((item) =>
            item.id === event.payload.id
              ? {
                  ...item,
                  status: event.payload.status,
                  result: event.payload.result,
                  durationMs: event.payload.durationMs,
                }
              : item
          ),
        })),
      };
      if (!chart) {
        return { session: withToolResult };
      }
      // 图表只保留查询定义；GrafanaPanelPreview 会按该定义重新查询，避免把原始样本
      // 写入 Agent 会话或公共事件。
      const withAssistantChart = mapLatestAssistant(withToolResult, (message) => ({
        ...message,
        charts: mergeCharts(message.charts ?? [], [chart]),
      }));
      return {
        session: {
          ...withAssistantChart,
          canvas: {
            ...withAssistantChart.canvas,
            visible: true,
            charts: mergeCharts(withAssistantChart.canvas.charts, [chart]),
          },
        },
      };
    }
    case 'folder_changed':
      return { session: opened, folderUid: event.payload.folderUid };
    case 'error':
      return {
        session: mapMessage(opened, assistantMessageId, (message) => ({
          ...message,
          content: message.content || event.payload.message,
          streamStatus: 'error',
        })),
      };
  }
}

export function markMessageStopped(opened: OpenedSession, assistantMessageId?: string): OpenedSession {
  if (!assistantMessageId) {
    return opened;
  }
  return mapMessage(opened, assistantMessageId, (message) => ({
    ...message,
    streamStatus: 'stopped',
  }));
}

export function mergeCharts(current: SavedChartPreview[], incoming: SavedChartPreview[]): SavedChartPreview[] {
  const next = current.map((chart) => ({ ...chart }));
  for (const chart of incoming) {
    // 标题不是标识符：同名图表可以同时存在，更新必须使用稳定 Chart ID。
    const index = next.findIndex(({ id }) => id === chart.id);
    if (index < 0) {
      next.push({ ...chart });
    } else {
      next[index] = { ...next[index], ...chart };
    }
  }
  return next;
}

function mapMessage(
  opened: OpenedSession,
  messageId: string,
  update: (message: WorkbenchMessage) => WorkbenchMessage
): OpenedSession {
  return {
    ...opened,
    messages: opened.messages.map((message) => (message.id === messageId ? update(message) : message)),
  };
}

function withMessages(opened: OpenedSession, messages: WorkbenchMessage[]): OpenedSession {
  return {
    ...opened,
    messages,
    session: {
      ...opened.session,
      messageCount: messages.length,
    },
  };
}

function findToolCall(messages: WorkbenchMessage[], id: string): ToolCall | undefined {
  for (const message of messages) {
    const match = message.toolCalls?.find((toolCall) => toolCall.id === id);
    if (match) {
      return match;
    }
  }
  return undefined;
}

function mapLatestAssistant(
  opened: OpenedSession,
  update: (message: WorkbenchMessage) => WorkbenchMessage
): OpenedSession {
  for (let index = opened.messages.length - 1; index >= 0; index--) {
    if (opened.messages[index].role !== 'assistant') {
      continue;
    }
    const messages = [...opened.messages];
    messages[index] = update(messages[index]);
    return { ...opened, messages };
  }
  return opened;
}

interface PrometheusToolArguments {
  datasourceUid?: unknown;
  datasource_uid?: unknown;
  datasource?: unknown;
  expr?: unknown;
  expression?: unknown;
  query?: unknown;
  startTime?: unknown;
  endTime?: unknown;
  stepSeconds?: unknown;
  queryType?: unknown;
  range?: unknown;
}

function chartFromPrometheusCall(toolCall: ToolCall | undefined, sessionId: string): SavedChartPreview | undefined {
  if (!toolCall || !isGrafanaPrometheusCall(toolCall)) {
    return undefined;
  }
  let args: PrometheusToolArguments;
  try {
    const parsed: unknown = JSON.parse(toolCall.args ?? '');
    if (!isRecord(parsed)) {
      return undefined;
    }
    args = parsed as PrometheusToolArguments;
  } catch {
    return undefined;
  }

  const expression = firstString(args.expr, args.expression, args.query);
  const datasourceUID = firstString(args.datasourceUid, args.datasource_uid, args.datasource);
  if (!expression || !datasourceUID || isInstantQuery(args.queryType)) {
    return undefined;
  }
  const range = normalizedRange(args);
  if (!range) {
    return undefined;
  }
  const callID = safeChartID(toolCall.id);
  const queryID = `query_${callID}`;
  const query: SavedQuery = {
    id: queryID,
    session_id: sessionId,
    version: 1,
    spec: {
      datasource_uid: datasourceUID,
      expression,
      range,
    },
    created_at: new Date().toISOString(),
  };
  return {
    id: `chart_${callID}`,
    title: expression,
    description: 'Grafana Prometheus 查询',
    visualization: 'line',
    renderMode: 'definition',
    vizConfig: {
      kind: 'VizConfig',
      group: 'timeseries',
      version: 'v1',
      spec: { options: {}, fieldConfig: { defaults: {}, overrides: [] } },
    },
    query,
  };
}

function isPrometheusQueryTool(tool: string): boolean {
  const normalized = tool.toLowerCase().replaceAll('-', '_');
  return (
    normalized === 'query_prometheus' || normalized === 'prometheus_query' || normalized.endsWith('_query_prometheus')
  );
}

function isInstantQuery(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'instant';
}

function isGrafanaPrometheusCall(toolCall: ToolCall): boolean {
  const server = toolCall.server.toLowerCase();
  if (!isPrometheusQueryTool(toolCall.tool)) {
    return false;
  }
  // Codex exposes the MCP server as "grafana". OpenCode currently projects
  // MCP tools through its generic "agent" namespace, while retaining the
  // Grafana-qualified tool name when one is available.
  return server === 'grafana' || server.startsWith('grafana-') || server === 'agent';
}

function normalizedRange(args: PrometheusToolArguments): SavedQuery['spec']['range'] | undefined {
  const nested = isRecord(args.range) ? args.range : undefined;
  const from = firstString(nested?.from, nested?.start, args.startTime) ?? relativeTime(60 * 60);
  const to = firstString(nested?.to, nested?.end, args.endTime) ?? 'now';
  const fromAbsolute = absoluteTime(from);
  const toAbsolute = absoluteTime(to);
  if (!fromAbsolute || !toAbsolute || fromAbsolute >= toAbsolute) {
    return undefined;
  }
  const step =
    firstNumber(nested?.step_seconds, nested?.stepSeconds, args.stepSeconds) ?? derivedStep(fromAbsolute, toAbsolute);
  if (!Number.isSafeInteger(step) || step <= 0) {
    return undefined;
  }
  return { from: fromAbsolute, to: toAbsolute, step_seconds: step };
}

function absoluteTime(value: string): string | undefined {
  const trimmed = value.trim();
  const parsed = /^now(?:-(\d+(?:\.\d+)?)([smhd]))?$/.exec(trimmed);
  if (parsed) {
    const amount = parsed[1] ? Number(parsed[1]) : 0;
    const unit = parsed[2] === 's' ? 1000 : parsed[2] === 'm' ? 60_000 : parsed[2] === 'h' ? 3_600_000 : 86_400_000;
    return new Date(Date.now() - amount * unit).toISOString();
  }
  const timestamp = Date.parse(trimmed);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function derivedStep(from: string, to: string): number {
  const seconds = Math.max(1, (Date.parse(to) - Date.parse(from)) / 1000);
  return Math.max(1, Math.ceil(seconds / 600));
}

function relativeTime(seconds: number): string {
  return `now-${Math.max(1, Math.round(seconds / 3600))}h`;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim() !== '')?.trim();
}

function firstNumber(...values: unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeChartID(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]/g, '_');
  return normalized.slice(0, 48) || 'query';
}
