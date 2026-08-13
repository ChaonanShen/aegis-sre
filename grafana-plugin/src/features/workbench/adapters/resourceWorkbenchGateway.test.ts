import { BackendSrv, BackendSrvRequest, FetchResponse } from '@grafana/runtime';
import { Observable, of } from 'rxjs';
import { AgentEvent } from '../model';
import { createResourceWorkbenchGateway } from './resourceWorkbenchGateway';

describe('createResourceWorkbenchGateway', () => {
  test('creates an unbound session without forwarding an untrusted Folder UID', async () => {
    const backendSrv = fakeBackend({ data: sessionContract });
    const gateway = createResourceWorkbenchGateway({ backendSrv });

    await gateway.createSession({
      title: '  CPU 排障  ',
      folder: { uid: 'infra', title: 'Infra', permission: 'Admin', serviceCount: 1 },
    });

    expect(backendSrv.fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        data: { title: 'CPU 排障' },
      })
    );
    expect((backendSrv.fetch as jest.Mock).mock.calls[0][0].data).not.toHaveProperty('active_folder_uid');
  });

  test('maps public SSE events and keeps VizConfig plus the absolute Query range', async () => {
    const chunks = [
      ': connected\n\n',
      'data: {"type":"message","payload":{"delta":"完成"}}\n\n',
      ': keepalive\n\n',
      'data: {"type":"tool_call","payload":{"name":"grafana.query_prometheus","arguments":{"query":"up"},"call_id":"call-1"}}\n\n',
      'data: {"type":"tool_result","payload":{"call_id":"call-1","content":{"status":"success"}}}\n\n',
      `data: ${JSON.stringify({
        type: 'chart',
        payload: {
          chart: chartContract,
          query: queryContract,
        },
      })}\n\n`,
      'data: {"type":"done","payload":{"turn_id":"turn-1","replayed":false}}\n\n',
    ];
    const backendSrv = fakeBackend({ chunks });
    const gateway = createResourceWorkbenchGateway({ backendSrv });
    const events = await collect(
      gateway.streamMessage(
        {
          clientTurnId: 'client-turn-1',
          sessionId: 'session-1',
          input: '最近 30 分钟 CPU',
          activeFolder: { uid: 'infra', title: 'Infra', permission: 'View', serviceCount: 0 },
          mentions: [],
          history: [],
        },
        new AbortController().signal
      )
    );

    expect(events.map(({ type }) => type)).toEqual([
      'message_start',
      'message_delta',
      'tool_call',
      'tool_result',
      'chart',
      'message_end',
      'done',
    ]);
    const generated = events.find((event) => event.type === 'chart');
    expect(generated?.type === 'chart' ? generated.payload : undefined).toMatchObject({
      renderMode: 'definition',
      vizConfig: chartContract.spec,
      query: {
        spec: {
          range: { from: '2026-07-29T02:00:00Z', to: '2026-07-29T02:30:00Z', step_seconds: 15 },
        },
      },
    });
    expect(generated?.type === 'chart' ? generated.payload : undefined).not.toHaveProperty('panel');
    expect(backendSrv.chunked).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          client_turn_id: 'client-turn-1',
          session_id: 'session-1',
          message: '最近 30 分钟 CPU',
          analysis_scope: { datasource_uids: [] },
          context: { mentions: [] },
        },
      })
    );
    expect((backendSrv.chunked as jest.Mock).mock.calls[0][0].data).not.toHaveProperty('runtime');
  });

  test('restores persisted charts as definitions instead of fixture curves', async () => {
    const detail = {
      session: sessionContract,
      turns: [],
      canvas: {
        id: 'canvas-1',
        session_id: 'session-1',
        layout: 'grid-2x2',
        charts: [{ chart_id: 'chart-1', x: 0, y: 0, w: 12, h: 8 }],
        version: 1,
        updated_at: '2026-07-29T02:30:00Z',
      },
      queries: [{ current: queryContract, versions: [queryContract] }],
      charts: [{ chart: chartContract }],
    };
    const gateway = createResourceWorkbenchGateway({ backendSrv: fakeBackend({ data: detail }) });

    await expect(gateway.openSession('session-1')).resolves.toMatchObject({
      canvas: {
        charts: [{ id: 'chart-1', renderMode: 'definition', query: queryContract, vizConfig: chartContract.spec }],
      },
    });
  });

  test('keeps the server canvas layout and excludes projected tool cards from message count', async () => {
    const detail = {
      session: sessionContract,
      turns: [
        {
          id: 'turn-1',
          session_id: 'session-1',
          client_turn_id: 'client-turn-1',
          index: 1,
          user_message: {
            id: 'message-user-1',
            role: 'user',
            content: '检查 CPU',
            created_at: '2026-07-29T02:00:00Z',
          },
          assistant_message: {
            id: 'message-assistant-1',
            role: 'assistant',
            content: 'CPU 正常。',
            tool_calls: [{ name: 'grafana.query_prometheus', arguments: { query: 'up' }, call_id: 'call-1' }],
            tool_results: [{ call_id: 'call-1', content: { status: 'success' } }],
            created_at: '2026-07-29T02:00:01Z',
          },
          created_at: '2026-07-29T02:00:00Z',
        },
      ],
      canvas: {
        id: 'canvas-1',
        session_id: 'session-1',
        layout: 'grid-3x2',
        charts: [],
        version: 1,
        updated_at: '2026-07-29T02:30:00Z',
      },
      queries: [],
      charts: [],
    };
    const gateway = createResourceWorkbenchGateway({ backendSrv: fakeBackend({ data: detail }) });

    await expect(gateway.openSession('session-1')).resolves.toMatchObject({
      session: { messageCount: 2 },
      messages: [{ role: 'user' }, { role: 'tool' }, { role: 'assistant' }],
      canvas: { layout: 'grid-3x2' },
    });
  });

  test('rejects a canvas layout outside the current contract', async () => {
    const detail = {
      session: sessionContract,
      turns: [],
      canvas: {
        id: 'canvas-1',
        session_id: 'session-1',
        layout: 'legacy-grid',
        charts: [],
        version: 1,
        updated_at: '2026-07-29T02:30:00Z',
      },
      queries: [],
      charts: [],
    };
    const gateway = createResourceWorkbenchGateway({ backendSrv: fakeBackend({ data: detail }) });

    await expect(gateway.openSession('session-1')).rejects.toMatchObject({ code: 1007 });
  });

  test('deletes a session through the Grafana Resource API', async () => {
    const backendSrv = fakeBackend({ data: undefined });
    const gateway = createResourceWorkbenchGateway({ backendSrv });

    await expect(gateway.deleteSession('session/with unsafe path')).resolves.toBeUndefined();
    expect(backendSrv.fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'DELETE',
        url: expect.stringContaining('/api/v1/sessions/session%2Fwith%20unsafe%20path'),
      })
    );
  });

  test('maps an interrupt to a resumable HITL request', async () => {
    const backendSrv = fakeBackend({
      chunks: [
        'data: {"type":"tool_call","payload":{"name":"grafana.write","arguments":{},"call_id":"call-1"}}\n\n',
        'data: {"type":"interrupt","payload":{"checkpoint_id":"checkpoint-1","reason":"需要审批"}}\n\n',
      ],
    });
    const gateway = createResourceWorkbenchGateway({ backendSrv });

    const events = await collect(
      gateway.streamMessage(
        {
          clientTurnId: 'turn-1',
          sessionId: 'session-1',
          input: '更新面板',
          mentions: [],
          history: [],
        },
        new AbortController().signal
      )
    );

    expect(events.at(-1)).toMatchObject({
      type: 'interrupt',
      payload: { id: 'checkpoint-1', clientTurnId: 'turn-1', toolCallId: 'call-1' },
    });
  });

  test('resumes an interrupted turn with its original client turn id', async () => {
    const backendSrv = fakeBackend({
      chunks: [
        'data: {"type":"message","payload":{"delta":"已继续"}}\n\n',
        'data: {"type":"done","payload":{"turn_id":"turn-1","replayed":false}}\n\n',
      ],
    });
    const gateway = createResourceWorkbenchGateway({ backendSrv });

    await expect(
      collect(
        gateway.resolveInterrupt(
          {
            sessionId: 'session-1',
            request: {
              id: 'checkpoint-1',
              clientTurnId: 'client-turn-1',
              toolCallId: 'call-1',
              server: 'agent',
              tool: 'approval',
              args: '',
              preview: [],
              reason: '需要审批',
            },
            decision: 'approved',
            activeFolder: { uid: 'infra', title: 'Infra', permission: 'Admin', serviceCount: 0 },
          },
          new AbortController().signal
        )
      )
    ).resolves.toEqual([
      { type: 'message_start' },
      { type: 'message_delta', payload: { delta: '已继续' } },
      { type: 'message_end', payload: {} },
      { type: 'done', payload: { turnId: 'turn-1', replayed: false } },
    ]);

    expect(backendSrv.chunked).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringContaining('/api/v1/chat/resume'),
        data: {
          session_id: 'session-1',
          client_turn_id: 'client-turn-1',
          checkpoint_id: 'checkpoint-1',
          decision: 'approved',
        },
      })
    );
  });

  test('buffers a split non-2xx response before decoding its business envelope', async () => {
    const backendSrv = fakeBackend({
      chunks: ['{"code":20', '06,"message":"Agent 正在处理上一条消息"}'],
      streamStatus: 409,
      streamStatusText: 'Conflict',
    });
    const gateway = createResourceWorkbenchGateway({ backendSrv });
    const iterator = gateway
      .streamMessage(
        {
          clientTurnId: 'turn-1',
          sessionId: 'session-1',
          input: 'CPU',
          mentions: [],
          history: [],
        },
        new AbortController().signal
      )
      [Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({ done: false, value: { type: 'message_start' } });
    await expect(iterator.next()).rejects.toMatchObject({
      status: 409,
      code: 2006,
      message: 'Agent 正在处理上一条消息',
    });
  });

  test('bounds the buffered non-2xx response body', async () => {
    const backendSrv = fakeBackend({
      chunks: ['x'.repeat(40 * 1024), 'y'.repeat(40 * 1024)],
      streamStatus: 502,
      streamStatusText: 'Bad Gateway',
    });
    const gateway = createResourceWorkbenchGateway({ backendSrv });
    const iterator = gateway
      .streamMessage(
        {
          clientTurnId: 'turn-1',
          sessionId: 'session-1',
          input: 'CPU',
          mentions: [],
          history: [],
        },
        new AbortController().signal
      )
      [Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({ done: false, value: { type: 'message_start' } });
    await expect(iterator.next()).rejects.toMatchObject({
      status: 502,
      code: 502,
      message: '流式错误响应超过 64 KiB 上限。',
    });
  });

  test('unsubscribe and AbortSignal cancel a live Grafana chunked request', async () => {
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
        {
          clientTurnId: 'turn-1',
          sessionId: 'session-1',
          input: 'CPU',
          mentions: [],
          history: [],
        },
        controller.signal
      )
      [Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toEqual({ done: false, value: { type: 'message_start' } });
    const pending = iterator.next();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(unsubscribed).toBe(true);
  });
});

const sessionContract = {
  id: 'session-1',
  tenant_id: 'stack-1',
  user_id: 'user-1',
  title: 'CPU',
  status: 'active',
  visibility: 'private',
  version: 1,
  created_at: '2026-07-29T02:00:00Z',
  updated_at: '2026-07-29T02:30:00Z',
};

const queryContract = {
  id: 'query-1',
  session_id: 'session-1',
  version: 1,
  spec: {
    datasource_uid: 'prometheus-main',
    expression: 'rate(node_cpu_seconds_total[5m])',
    range: { from: '2026-07-29T02:00:00Z', to: '2026-07-29T02:30:00Z', step_seconds: 15 },
  },
  created_at: '2026-07-29T02:30:00Z',
};

const chartContract = {
  id: 'chart-1',
  version: 1,
  type: 'timeseries',
  title: 'CPU',
  query_id: 'query-1',
  spec: {
    kind: 'VizConfig',
    group: 'timeseries',
    version: '13.1.0',
    spec: {
      options: { legend: { displayMode: 'list' } },
      fieldConfig: { defaults: { custom: {} }, overrides: [] },
    },
  },
  created_at: '2026-07-29T02:30:00Z',
};

function fakeBackend(options: {
  data?: unknown;
  chunks?: string[];
  stream?: Observable<FetchResponse<Uint8Array | undefined>>;
  streamStatus?: number;
  streamStatusText?: string;
}): BackendSrv {
  const response = (data: unknown, status = 200, statusText = 'OK'): FetchResponse<unknown> =>
    ({
      data,
      status,
      statusText,
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
          response(new TextEncoder().encode(chunk), options.streamStatus, options.streamStatusText) as FetchResponse<
            Uint8Array | undefined
          >
      )
    );
  const fetch = jest.fn((_request: BackendSrvRequest) => of(response({ code: 0, data: options.data })));
  const chunked = jest.fn(() => stream);
  return {
    fetch,
    chunked,
  } as unknown as BackendSrv;
}

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const values: AgentEvent[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
}
