import { seededSessions } from '../fixtures/workbenchFixtures';
import { OpenedSession } from '../model';
import { applyAgentEvent, markMessageStopped, mergeCharts } from './workbenchReducer';

describe('workbenchReducer', () => {
  test('applies message deltas and completes charts into the message and canvas', () => {
    const assistantId = 'assistant';
    let opened: OpenedSession = {
      ...seededSessions[0],
      messages: [{ id: assistantId, role: 'assistant' as const, content: '', streamStatus: 'streaming' as const }],
      canvas: { ...seededSessions[0].canvas, charts: [] },
    };

    opened = applyAgentEvent(opened, { type: 'message_delta', payload: { delta: '完成' } }, assistantId).session;
    opened = applyAgentEvent(
      opened,
      {
        type: 'message_end',
        payload: {
          charts: [{ id: 'chart-new', title: '新图', description: 'fixture', visualization: 'line' }],
        },
      },
      assistantId
    ).session;

    expect(opened.messages[0]).toMatchObject({ content: '完成', streamStatus: 'complete' });
    expect(opened.messages[0].charts).toHaveLength(1);
    expect(opened.canvas.charts).toHaveLength(1);
  });

  test('inserts and resolves a tool call before the assistant message', () => {
    const assistantId = 'assistant';
    let opened: OpenedSession = {
      ...seededSessions[0],
      messages: [{ id: assistantId, role: 'assistant' as const, content: '' }],
    };
    opened = applyAgentEvent(
      opened,
      {
        type: 'tool_call',
        payload: { id: 'tc', server: 'grafana', tool: 'query', tier: 'read', status: 'pending' },
      },
      assistantId
    ).session;
    opened = applyAgentEvent(
      opened,
      { type: 'tool_result', payload: { id: 'tc', status: 'ok', result: 'done', durationMs: 12 } },
      assistantId
    ).session;

    expect(opened.messages[0].role).toBe('tool');
    expect(opened.messages[0].toolCalls?.[0]).toMatchObject({ status: 'ok', result: 'done', durationMs: 12 });
  });

  test('marks an aborted assistant message as stopped', () => {
    const opened = {
      ...seededSessions[0],
      messages: [{ id: 'assistant', role: 'assistant' as const, content: 'partial', streamStatus: 'streaming' as const }],
    };

    expect(markMessageStopped(opened, 'assistant').messages[0].streamStatus).toBe('stopped');
  });

  test('merges charts by stable id while preserving order', () => {
    expect(
      mergeCharts(
        [{ id: 'old', title: 'p95', description: 'old', visualization: 'line' }],
        [
          { id: 'old', title: 'p99', description: 'updated', visualization: 'stat' },
          { id: 'second', title: 'p95', description: 'new', visualization: 'line' },
        ]
      )
    ).toEqual([
      { id: 'old', title: 'p99', description: 'updated', visualization: 'stat' },
      { id: 'second', title: 'p95', description: 'new', visualization: 'line' },
    ]);
  });
});
