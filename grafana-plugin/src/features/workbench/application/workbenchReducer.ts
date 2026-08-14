import { AgentEvent, OpenedSession, SavedChartPreview, WorkbenchMessage } from '../model';

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
    case 'tool_result':
      return {
        session: {
          ...opened,
          messages: opened.messages.map((message) => ({
            ...message,
            toolCalls: message.toolCalls?.map((toolCall) =>
              toolCall.id === event.payload.id
                ? {
                    ...toolCall,
                    status: event.payload.status,
                    result: event.payload.result,
                    durationMs: event.payload.durationMs,
                  }
                : toolCall
            ),
          })),
        },
      };
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
