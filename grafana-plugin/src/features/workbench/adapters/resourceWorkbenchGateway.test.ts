import { BackendSrv, BackendSrvRequest, FetchResponse } from '@grafana/runtime';
import { Observable, of } from 'rxjs';
import { AgentEvent } from '../model';
import { createResourceWorkbenchGateway } from './resourceWorkbenchGateway';

describe('Control Plane Workbench gateway', () => {
  test('uses the direct v1 page contract', async () => {
    const backendSrv = fakeBackend({ data: { items: [session], has_more: false } });
    const gateway = createResourceWorkbenchGateway({ backendSrv });

    await expect(gateway.listSessions()).resolves.toEqual([
      expect.objectContaining({ id: session.id, title: session.title, status: 'active', folderUid: '' }),
    ]);
  });

  test('loads every session page through the opaque cursor', async () => {
    const second = { ...session, id: 'ses_second123', title: 'Second' };
    const backendSrv = {
      fetch: jest
        .fn()
        .mockReturnValueOnce(of({ data: { items: [session], has_more: true, next_cursor: 'next page' }, status: 200 } as FetchResponse))
        .mockReturnValueOnce(of({ data: { items: [second], has_more: false }, status: 200 } as FetchResponse)),
    } as unknown as BackendSrv;
    const gateway = createResourceWorkbenchGateway({ backendSrv });

    await expect(gateway.listSessions()).resolves.toEqual([
      expect.objectContaining({ id: session.id }),
      expect.objectContaining({ id: second.id }),
    ]);
    expect((backendSrv.fetch as jest.Mock).mock.calls[1][0].url).toContain('?cursor=next%20page');
  });

  test('creates a session with an idempotency key and without browser Folder authority', async () => {
    const backendSrv = fakeBackend({ data: session });
    const gateway = createResourceWorkbenchGateway({ backendSrv });

    await gateway.createSession({
      title: '  CPU 排障  ',
      folder: { uid: 'infra', title: 'Infra', permission: 'Admin', serviceCount: 1 },
    });

    const request = (backendSrv.fetch as jest.Mock).mock.calls[0][0] as BackendSrvRequest;
    expect(request).toEqual(
      expect.objectContaining({
        method: 'POST',
        data: { title: 'CPU 排障' },
        headers: { 'Idempotency-Key': expect.stringMatching(/^session-/) },
      })
    );
    expect(request.data).not.toHaveProperty('folder_uid');
  });

  test('loads and updates the persisted Canvas projection with its revision', async () => {
    const projection = {
      session_id: session.id,
      visible: true,
      layout: 'grid-2x2',
      active_chart_id: 'cht_abcdefgh',
      revision: 3,
      items: [
        {
          position: 0,
          chart: {
            id: 'cht_abcdefgh',
            revision: 1,
            query: {
              id: 'qry_abcdefgh',
              version: 1,
              datasource_uid: 'prom-main',
              expression: 'up',
              range: { from: '2026-08-15T00:00:00Z', to: '2026-08-15T01:00:00Z', step_seconds: 30 },
              created_at: '2026-08-15T01:00:00Z',
            },
            title: 'Availability',
            description: '',
            visualization: 'timeseries',
            viz_config: {
              kind: 'VizConfig',
              group: 'timeseries',
              version: 'v1',
              spec: { options: {}, fieldConfig: { defaults: {}, overrides: [] } },
            },
            created_at: '2026-08-15T01:00:00Z',
            updated_at: '2026-08-15T01:00:00Z',
          },
        },
      ],
    };
    const backendSrv = {
      fetch: jest.fn((request: BackendSrvRequest) =>
        of({
          data: request.url?.endsWith('/canvas') ? projection : { session, messages: [] },
          status: 200,
          statusText: 'OK',
          ok: true,
          headers: new Headers(),
        } as FetchResponse<unknown>)
      ),
      chunked: jest.fn(),
    } as unknown as BackendSrv;
    const gateway = createResourceWorkbenchGateway({ backendSrv });
    await expect(gateway.openSession(session.id)).resolves.toMatchObject({
      canvas: { revision: 3, charts: [{ id: 'cht_abcdefgh' }] },
    });
    await gateway.updateCanvas!(session.id, { ...projectionToCanvas(projection), visible: false });
    const update = (backendSrv.fetch as jest.Mock).mock.calls.at(-1)?.[0] as BackendSrvRequest;
    expect(update.headers).toMatchObject({ 'If-Match': '"canvas:3"' });
    expect(update.data).toMatchObject({ visible: false, ordered_chart_ids: ['cht_abcdefgh'] });
  });

  test('maps stable SSE events and sends the turn idempotency key', async () => {
    const chunks = [
      event({ event_type: 'turn.started', turn_id: 'turn_0123456789', payload: { status: 'running' } }),
      event({ event_type: 'message.delta', payload: { delta: '完成' } }),
      event({
        event_type: 'tool.started',
        payload: {
          call_id: 'call_0123456789',
          server: 'grafana-read',
          tool: 'query',
          arguments: { expr: 'up' },
          access: 'read',
        },
      }),
      event({
        event_type: 'tool.completed',
        payload: { call_id: 'call_0123456789', status: 'succeeded', summary: '1 series', duration_ms: 12 },
      }),
      event({ event_type: 'turn.completed', turn_id: 'turn_0123456789', payload: { status: 'succeeded' } }),
    ];
    const backendSrv = fakeBackend({ chunks });
    const gateway = createResourceWorkbenchGateway({ backendSrv });
    const events = await collect(
      gateway.streamMessage(
        {
          clientTurnId: 'client-turn-1',
          sessionId: session.id,
          input: 'CPU',
          mentions: ['service:api'],
          activeFolder: { uid: 'infra', title: 'Infra', permission: 'View', serviceCount: 0 },
        },
        new AbortController().signal
      )
    );

    expect(events.map(({ type }) => type)).toEqual([
      'message_start',
      'turn_started',
      'message_delta',
      'tool_call',
      'tool_result',
      'message_end',
      'done',
    ]);
    expect(backendSrv.chunked).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringContaining(`/api/v1/sessions/${session.id}/turns:stream`),
        data: { message: 'CPU', mentions: ['service:api'] },
        headers: { 'Idempotency-Key': 'client-turn-1', 'X-Aegis-Folder-UID': 'infra' },
      })
    );
  });

  test('maps canvas.updated into a refreshable Workbench event', async () => {
    const backendSrv = fakeBackend({
      chunks: [
        event({
          event_type: 'canvas.updated',
          payload: { chart_id: 'cht_abcdefgh', operation_id: 'operation-1', revision: 2 },
          turn_id: 'turn_0123456789',
        }),
        event({ event_type: 'turn.completed', turn_id: 'turn_0123456789', payload: { status: 'succeeded' } }),
      ],
    });
    const gateway = createResourceWorkbenchGateway({ backendSrv });
    const events = await collect(
      gateway.streamMessage(
        { clientTurnId: 'client-turn-1', sessionId: session.id, input: 'chart', mentions: [] },
        new AbortController().signal
      )
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'canvas_updated',
        payload: expect.objectContaining({ chartId: 'cht_abcdefgh', revision: 2 }),
      })
    );
  });

  test('cancels a concrete provider turn instead of treating SSE abort as cancellation', async () => {
    const backendSrv = fakeBackend({ data: undefined });
    const gateway = createResourceWorkbenchGateway({ backendSrv });

    await gateway.cancelTurn(session.id, 'turn_0123456789', 'cancel-client-turn-1');

    const request = (backendSrv.fetch as jest.Mock).mock.calls[0][0] as BackendSrvRequest;
    expect(request).toEqual(
      expect.objectContaining({
        method: 'POST',
        url: expect.stringContaining(`/api/v1/sessions/${session.id}/turns/turn_0123456789:cancel`),
        headers: { 'Idempotency-Key': 'cancel-client-turn-1' },
      })
    );
  });

  test('maps approval requests to the existing HITL view', async () => {
    const backendSrv = fakeBackend({
      chunks: [
        event({
          event_type: 'approval.requested',
          payload: {
            approval_id: 'apr_0123456789',
            action: 'restart',
            reason: '高风险操作',
            risk: 'high',
            preview: ['pod/api'],
          },
        }),
      ],
    });
    const gateway = createResourceWorkbenchGateway({ backendSrv });
    const events = await collect(
      gateway.streamMessage(
        { clientTurnId: 'client-turn-1', sessionId: session.id, input: 'restart', mentions: [] },
        new AbortController().signal
      )
    );
    expect(events.at(-1)).toMatchObject({
      type: 'interrupt',
      payload: { id: 'apr_0123456789', clientTurnId: 'client-turn-1', tool: 'restart' },
    });
  });

  test('decodes a split problem response without exposing upstream details', async () => {
    const problem = JSON.stringify({
      type: 'about:blank',
      title: 'Conflict',
      status: 409,
      code: 'conflict',
      detail: 'session busy',
      request_id: 'req-1',
      trace_id: 'trace-1',
      retryable: false,
    });
    const backendSrv = fakeBackend({ chunks: [problem.slice(0, 20), problem.slice(20)], streamStatus: 409 });
    const gateway = createResourceWorkbenchGateway({ backendSrv });
    const iterator = gateway
      .streamMessage(
        { clientTurnId: 'client-turn-1', sessionId: session.id, input: 'CPU', mentions: [] },
        new AbortController().signal
      )
      [Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({ done: false, value: { type: 'message_start' } });
    await expect(iterator.next()).rejects.toMatchObject({ status: 409, message: 'session busy' });
  });

  test('aborting a live stream unsubscribes the Grafana request', async () => {
    let unsubscribed = false;
    const backendSrv = fakeBackend({
      stream: new Observable(() => () => {
        unsubscribed = true;
      }),
    });
    const gateway = createResourceWorkbenchGateway({ backendSrv });
    const controller = new AbortController();
    const iterator = gateway
      .streamMessage(
        { clientTurnId: 'client-turn-1', sessionId: session.id, input: 'CPU', mentions: [] },
        controller.signal
      )
      [Symbol.asyncIterator]();
    await iterator.next();
    const pending = iterator.next();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(unsubscribed).toBe(true);
  });
});

const session = {
  id: 'ses_0123456789',
  title: 'CPU',
  status: 'active',
  folder_uid: 'must-not-be-projected',
  created_at: '2026-08-13T01:00:00Z',
  updated_at: '2026-08-13T01:01:00Z',
};

function projectionToCanvas(projection: any) {
  return {
    visible: projection.visible,
    layout: projection.layout,
    revision: projection.revision,
    activeChartId: projection.active_chart_id,
    charts: projection.items.map((item: any) => {
      const chart = item.chart;
      return {
        id: chart.id,
        title: chart.title,
        description: chart.description,
        visualization: 'line' as const,
        vizConfig: chart.viz_config,
        query: {
          id: chart.query.id,
          session_id: 'ses_abcdefgh',
          version: chart.query.version,
          spec: {
            datasource_uid: chart.query.datasource_uid,
            expression: chart.query.expression,
            range: chart.query.range,
          },
          created_at: chart.query.created_at,
        },
      };
    }),
  };
}

let sequence = 0;
function event(input: { event_type: string; payload: object; turn_id?: string }): string {
  sequence += 1;
  return `data: ${JSON.stringify({
    event_id: `evt_01234567${sequence}`,
    sequence,
    occurred_at: '2026-08-13T01:00:00Z',
    ...input,
  })}\n\n`;
}

function fakeBackend(options: {
  data?: unknown;
  chunks?: string[];
  stream?: Observable<FetchResponse<Uint8Array | undefined>>;
  streamStatus?: number;
}): BackendSrv {
  const response = (data: unknown, status = 200): FetchResponse<unknown> =>
    ({
      data,
      status,
      statusText: status === 200 ? 'OK' : 'Error',
      ok: status >= 200 && status < 300,
      headers: new Headers(),
      redirected: false,
      type: 'basic',
      url: '',
      config: { url: '' },
    }) as FetchResponse<unknown>;
  const stream =
    options.stream ??
    of(
      ...(options.chunks ?? []).map(
        (chunk) =>
          response(new TextEncoder().encode(chunk), options.streamStatus) as FetchResponse<Uint8Array | undefined>
      )
    );
  return {
    fetch: jest.fn(() => of(response(options.data))),
    chunked: jest.fn(() => stream),
  } as unknown as BackendSrv;
}

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const values: AgentEvent[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
}
