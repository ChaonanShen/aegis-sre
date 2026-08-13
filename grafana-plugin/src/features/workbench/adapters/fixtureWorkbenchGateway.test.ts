import { AgentEvent } from '../model';
import { fixtureFolders } from '../fixtures/workbenchFixtures';
import { createFixtureWorkbenchGateway } from './fixtureWorkbenchGateway';

describe('createFixtureWorkbenchGateway', () => {
  test('seeds, creates, archives, and reopens sessions', async () => {
    const storage = createMemoryStorage();
    const gateway = createFixtureWorkbenchGateway({
      storage,
      latencyMs: 0,
      streamDelayMs: 0,
      newId: () => 'session-new',
      now: () => new Date('2026-07-25T15:00:00.000Z'),
    });

    expect((await gateway.listSessions())[0].id).toBe('s-001');
    const created = await gateway.createSession({ title: '  新的排障会话  ', folder: fixtureFolders[1] });
    expect(created.session).toMatchObject({
      id: 'session-new',
      title: '新的排障会话',
      folderUid: 'payment',
      visibility: 'private',
    });
    expect((await gateway.openSession('session-new')).messages).toEqual([]);

    await gateway.archiveSession('session-new');
    expect((await gateway.openSession('session-new')).session.status).toBe('archived');
  });

  test('recovers malformed persisted data', async () => {
    const storage = createMemoryStorage();
    storage.setItem('fixture', '{bad json');
    const gateway = createFixtureWorkbenchGateway({ storage, storageKey: 'fixture', latencyMs: 0 });

    await expect(gateway.listSessions()).resolves.toHaveLength(5);
    expect(JSON.parse(storage.getItem('fixture') ?? '[]')).toHaveLength(5);
  });

  test('creates and chats in an unbound fixture session', async () => {
    const gateway = createFixtureWorkbenchGateway({ latencyMs: 0, streamDelayMs: 0, newId: () => 'unbound' });

    await expect(gateway.createSession({ title: '未绑定会话' })).resolves.toMatchObject({
      session: { id: 'unbound', folderUid: '', folderTitle: '未绑定' },
    });
    const events = await collect(
      gateway.streamMessage(
        {
          clientTurnId: 'turn-unbound',
          sessionId: 'unbound',
          input: '查询 p95',
          mentions: [],
          history: [],
        },
        new AbortController().signal
      )
    );

    expect(events.at(-1)).toEqual({ type: 'done', payload: { turnId: 'turn-unbound', replayed: false } });
  });

  test('emits a stable tool call and interrupt id for write requests', async () => {
    const gateway = createFixtureWorkbenchGateway({ latencyMs: 0, streamDelayMs: 0 });
    const controller = new AbortController();
    const events = await collect(
      gateway.streamMessage(
        {
          clientTurnId: 'turn-command-1',
          sessionId: 's-001',
          input: '创建一个 p99 panel',
          activeFolder: fixtureFolders[1],
          mentions: [],
          history: [],
        },
        controller.signal
      )
    );
    const toolCall = events.find((event) => event.type === 'tool_call');
    const interrupt = events.find((event) => event.type === 'interrupt');

    expect(toolCall?.type === 'tool_call' ? toolCall.payload.id : undefined).toBe(
      interrupt?.type === 'interrupt' ? interrupt.payload.toolCallId : undefined
    );
  });

  test('routes switch-folder before a generic slash command', async () => {
    const gateway = createFixtureWorkbenchGateway({ latencyMs: 0, streamDelayMs: 0 });
    const events = await collect(
      gateway.streamMessage(
        {
          clientTurnId: 'turn-command-2',
          sessionId: 's-001',
          input: '/switch-folder search',
          activeFolder: fixtureFolders[3],
          mentions: [],
          history: [],
        },
        new AbortController().signal
      )
    );

    expect(events).toContainEqual({ type: 'folder_changed', payload: { folderUid: 'search' } });
    expect(events.some((event) => event.type === 'tool_call')).toBe(false);
  });

  test('marks approved Fixture requests as simulated without claiming write or audit side effects', async () => {
    const gateway = createFixtureWorkbenchGateway({ latencyMs: 0, streamDelayMs: 0 });
    const events = await collect(
      gateway.resolveInterrupt(
        {
          sessionId: 's-001',
          request: {
            id: 'interrupt-1',
            clientTurnId: 'turn-resume-1',
            toolCallId: 'tool-1',
            server: 'grafana',
            tool: 'dashboard.update',
            args: '{}',
            preview: ['更新面板'],
            reason: '写操作需要审批',
          },
          decision: 'approved',
          feedback: '同意演示',
          activeFolder: fixtureFolders[1],
        },
        new AbortController().signal
      )
    );
    const toolResult = events.find((event) => event.type === 'tool_result');
    const message = events
      .filter((event) => event.type === 'message_delta')
      .map((event) => (event.type === 'message_delta' ? event.payload.delta : ''))
      .join('');

    expect(toolResult?.type === 'tool_result' ? toolResult.payload.result : '').toContain('演示审批已通过');
    expect(message).toContain('未执行真实写操作');
    expect(message).toContain('未写入审计日志');
    expect(message).not.toContain('操作已执行');
  });

  test('aborts an in-flight stream', async () => {
    const gateway = createFixtureWorkbenchGateway({ latencyMs: 0, streamDelayMs: 20 });
    const controller = new AbortController();
    const iterator = gateway.streamMessage(
      {
        clientTurnId: 'turn-command-3',
        sessionId: 's-001',
        input: 'p95 latency',
        activeFolder: fixtureFolders[3],
        mentions: [],
        history: [],
      },
      controller.signal
    )[Symbol.asyncIterator]();

    await iterator.next();
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
  });
});

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const values: AgentEvent[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
}

function createMemoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}
