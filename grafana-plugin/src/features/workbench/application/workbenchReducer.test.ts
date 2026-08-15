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

  test('turns a successful Grafana Prometheus call into a live Grafana panel definition', () => {
    const assistantId = 'assistant';
    let opened: OpenedSession = {
      ...seededSessions[0],
      messages: [{ id: assistantId, role: 'assistant' as const, content: '' }],
      canvas: { ...seededSessions[0].canvas, charts: [] },
    };
    opened = applyAgentEvent(
      opened,
      {
        type: 'tool_call',
        payload: {
          id: 'call-prometheus',
          server: 'grafana',
          tool: 'query_prometheus',
          tier: 'read',
          args: JSON.stringify({
            datasourceUid: 'prom-main',
            expr: 'rate(http_requests_total[5m])',
            startTime: '2026-08-14T00:00:00Z',
            endTime: '2026-08-14T01:00:00Z',
            stepSeconds: 30,
            queryType: 'range',
          }),
          status: 'pending',
        },
      },
      assistantId
    ).session;
    opened = applyAgentEvent(
      opened,
      { type: 'tool_result', payload: { id: 'call-prometheus', status: 'ok', result: 'summary', durationMs: 42 } },
      assistantId
    ).session;

    const chart = opened.messages.find(({ role }) => role === 'assistant')?.charts?.[0];
    expect(chart).toMatchObject({
      id: 'chart_call-prometheus',
      renderMode: 'definition',
      visualization: 'line',
      query: {
        session_id: seededSessions[0].session.id,
        spec: {
          datasource_uid: 'prom-main',
          expression: 'rate(http_requests_total[5m])',
          range: { from: '2026-08-14T00:00:00.000Z', to: '2026-08-14T01:00:00.000Z', step_seconds: 30 },
        },
      },
      vizConfig: { kind: 'VizConfig', group: 'timeseries' },
    });
    expect(opened.canvas.visible).toBe(true);
    expect(opened.canvas.charts).toEqual([chart]);
  });

  test('does not create a chart for failed or non-Prometheus Grafana calls', () => {
    const assistantId = 'assistant';
    let opened: OpenedSession = {
      ...seededSessions[0],
      messages: [{ id: assistantId, role: 'assistant' as const, content: '' }],
      canvas: { ...seededSessions[0].canvas, charts: [] },
    };
    opened = applyAgentEvent(
      opened,
      {
        type: 'tool_call',
        payload: {
          id: 'call-search',
          server: 'grafana',
          tool: 'list_prometheus_metric_names',
          tier: 'read',
          args: JSON.stringify({ datasourceUid: 'prom-main' }),
          status: 'pending',
        },
      },
      assistantId
    ).session;
    opened = applyAgentEvent(
      opened,
      { type: 'tool_result', payload: { id: 'call-search', status: 'ok', result: 'summary', durationMs: 1 } },
      assistantId
    ).session;
    expect(opened.canvas.charts).toHaveLength(0);
  });

  test('does not create a time-series chart for an instant Prometheus call', () => {
    const assistantId = 'assistant';
    let opened: OpenedSession = {
      ...seededSessions[0],
      messages: [{ id: assistantId, role: 'assistant' as const, content: '' }],
      canvas: { ...seededSessions[0].canvas, charts: [] },
    };
    opened = applyAgentEvent(
      opened,
      {
        type: 'tool_call',
        payload: {
          id: 'call-instant',
          server: 'grafana',
          tool: 'query_prometheus',
          tier: 'read',
          args: JSON.stringify({
            datasourceUid: 'prom-main',
            expr: 'up',
            startTime: '2026-08-14T00:00:00Z',
            endTime: '2026-08-14T01:00:00Z',
            queryType: 'instant',
          }),
          status: 'pending',
        },
      },
      assistantId
    ).session;
    opened = applyAgentEvent(
      opened,
      { type: 'tool_result', payload: { id: 'call-instant', status: 'ok', result: 'summary', durationMs: 3 } },
      assistantId
    ).session;

    expect(opened.canvas.charts).toHaveLength(0);
  });

  test('marks an aborted assistant message as stopped', () => {
    const opened = {
      ...seededSessions[0],
      messages: [
        { id: 'assistant', role: 'assistant' as const, content: 'partial', streamStatus: 'streaming' as const },
      ],
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
