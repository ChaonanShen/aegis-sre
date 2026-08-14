import { act, renderHook, waitFor } from '@testing-library/react';
import { fixtureFolders } from '../fixtures/workbenchFixtures';
import {
  AgentEvent,
  OpenedSession,
  ResourceRequestError,
  ResolveInterruptInput,
  SendMessageInput,
  SessionSummary,
  WorkbenchContext,
} from '../model';
import { WorkbenchGateway } from '../ports/WorkbenchGateway';
import { createFixtureWorkbenchGateway } from '../adapters/fixtureWorkbenchGateway';
import { useWorkbenchController } from './useWorkbenchController';

describe('useWorkbenchController', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  test('navigates to the newest session when the route has no session id', async () => {
    const onNavigate = jest.fn();

    renderHook(() =>
      useWorkbenchController({
        gateway: createFixtureWorkbenchGateway({ latencyMs: 0 }),
        activeFolder: fixtureFolders[1],
        onNavigate,
        onFolderChange: jest.fn(),
      })
    );

    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('s-001', true));
  });

  test('does not let a stale session list replace the latest refresh', async () => {
    const first = deferred<SessionSummary[]>();
    const second = deferred<SessionSummary[]>();
    const baseGateway = createFixtureWorkbenchGateway({ latencyMs: 0 });
    let call = 0;
    const gateway: WorkbenchGateway = {
      ...baseGateway,
      listSessions: jest.fn((signal?: AbortSignal) => {
        call += 1;
        expect(signal).toBeInstanceOf(AbortSignal);
        return call === 1 ? first.promise : second.promise;
      }),
    };
    const { result } = renderHook(() =>
      useWorkbenchController({
        gateway,
        sessionId: 's-001',
        activeFolder: fixtureFolders[1],
        onNavigate: jest.fn(),
        onFolderChange: jest.fn(),
      })
    );

    await waitFor(() => expect(gateway.listSessions).toHaveBeenCalledTimes(1));
    act(() => {
      void result.current.retrySessions();
    });
    await waitFor(() => expect(gateway.listSessions).toHaveBeenCalledTimes(2));

    await act(async () => second.resolve([summary('s-002')]));
    await waitFor(() => expect(result.current.sessions).toMatchObject({ data: [{ id: 's-002' }] }));
    await act(async () => first.resolve([summary('s-001')]));

    expect(result.current.sessions).toMatchObject({ data: [{ id: 's-002' }] });
  });

  test('does not let an in-flight session list undo a created Session', async () => {
    const first = deferred<SessionSummary[]>();
    const baseGateway = createFixtureWorkbenchGateway({ latencyMs: 0 });
    let listCall = 0;
    const gateway: WorkbenchGateway = {
      ...baseGateway,
      listSessions: jest.fn(() => {
        listCall += 1;
        return listCall === 1 ? first.promise : Promise.resolve([summary('session-new')]);
      }),
      createSession: jest.fn(async () => openedSession('session-new')),
    };
    const { result } = renderHook(() =>
      useWorkbenchController({ gateway, onNavigate: jest.fn(), onFolderChange: jest.fn() })
    );

    await waitFor(() => expect(gateway.listSessions).toHaveBeenCalledTimes(1));
    await act(async () => {
      await result.current.createSession('新会话');
    });
    await waitFor(() => expect(result.current.sessions).toMatchObject({ data: [{ id: 'session-new' }] }));

    await act(async () => first.resolve([summary('stale-session')]));
    expect(result.current.sessions).toMatchObject({ data: [{ id: 'session-new' }] });
  });

  test('does not let a stale open request replace the latest session', async () => {
    const first = deferred<OpenedSession>();
    const second = deferred<OpenedSession>();
    const baseGateway = createFixtureWorkbenchGateway({ latencyMs: 0 });
    const gateway: WorkbenchGateway = {
      ...baseGateway,
      openSession: jest.fn((sessionId: string) => (sessionId === 's-001' ? first.promise : second.promise)),
    };
    const { result, rerender } = renderHook(
      ({ sessionId }) =>
        useWorkbenchController({
          gateway,
          sessionId,
          activeFolder: fixtureFolders[1],
          onNavigate: jest.fn(),
          onFolderChange: jest.fn(),
        }),
      { initialProps: { sessionId: 's-001' } }
    );

    await waitFor(() => expect(gateway.openSession).toHaveBeenCalledWith('s-001', expect.any(AbortSignal)));
    rerender({ sessionId: 's-002' });
    await waitFor(() => expect(gateway.openSession).toHaveBeenCalledWith('s-002', expect.any(AbortSignal)));

    await act(async () => second.resolve(openedSession('s-002')));
    await waitFor(() => expect(result.current.openedSession).toMatchObject({ data: { session: { id: 's-002' } } }));

    await act(async () => first.resolve(openedSession('s-001')));
    expect(result.current.openedSession).toMatchObject({ data: { session: { id: 's-002' } } });
  });

  test('does not let a stale Folder context replace the latest result', async () => {
    const first = deferred<WorkbenchContext>();
    const second = deferred<WorkbenchContext>();
    const baseGateway = createFixtureWorkbenchGateway({ latencyMs: 0 });
    const gateway: WorkbenchGateway = {
      ...baseGateway,
      getContext: jest.fn((folderUid: string) => (folderUid === 'payment' ? first.promise : second.promise)),
    };
    const { result, rerender } = renderHook(
      ({ folder }) =>
        useWorkbenchController({
          gateway,
          activeFolder: folder,
          onNavigate: jest.fn(),
          onFolderChange: jest.fn(),
        }),
      { initialProps: { folder: fixtureFolders[1] as (typeof fixtureFolders)[number] | undefined } }
    );

    await waitFor(() => expect(gateway.getContext).toHaveBeenCalledWith('payment', expect.any(AbortSignal)));
    rerender({ folder: fixtureFolders[2] });
    await waitFor(() => expect(gateway.getContext).toHaveBeenCalledWith('search', expect.any(AbortSignal)));
    expect(result.current.context).toEqual({ status: 'loading' });

    await act(async () => second.resolve(contextFor('search')));
    await waitFor(() => expect(result.current.context).toMatchObject({ data: { activeFolder: { uid: 'search' } } }));
    await act(async () => first.resolve(contextFor('payment')));

    expect(result.current.context).toMatchObject({ data: { activeFolder: { uid: 'search' } } });
  });

  test('does not retain Folder context after the active Folder is cleared', async () => {
    const gateway = createFixtureWorkbenchGateway({ latencyMs: 0 });
    const { result, rerender } = renderHook(
      ({ folder }: { folder?: (typeof fixtureFolders)[number] }) =>
        useWorkbenchController({
          gateway,
          activeFolder: folder,
          onNavigate: jest.fn(),
          onFolderChange: jest.fn(),
        }),
      { initialProps: { folder: fixtureFolders[1] as (typeof fixtureFolders)[number] | undefined } }
    );

    await waitFor(() => expect(result.current.context.status).toBe('success'));
    rerender({ folder: undefined });

    expect(result.current.context).toEqual({ status: 'idle' });
  });

  test('does not retry context for a Folder captured before the scope changed', async () => {
    const first = deferred<WorkbenchContext>();
    const second = deferred<WorkbenchContext>();
    const baseGateway = createFixtureWorkbenchGateway({ latencyMs: 0 });
    const gateway: WorkbenchGateway = {
      ...baseGateway,
      getContext: jest.fn((folderUid: string) => (folderUid === 'payment' ? first.promise : second.promise)),
    };
    const { result, rerender } = renderHook(
      ({ folder }) =>
        useWorkbenchController({
          gateway,
          activeFolder: folder,
          onNavigate: jest.fn(),
          onFolderChange: jest.fn(),
        }),
      { initialProps: { folder: fixtureFolders[1] } }
    );

    await waitFor(() => expect(gateway.getContext).toHaveBeenCalledWith('payment', expect.any(AbortSignal)));
    const retryPaymentContext = result.current.retryContext;
    rerender({ folder: fixtureFolders[2] });
    await waitFor(() => expect(gateway.getContext).toHaveBeenCalledWith('search', expect.any(AbortSignal)));

    act(() => retryPaymentContext());
    expect(gateway.getContext).toHaveBeenCalledTimes(2);

    await act(async () => second.resolve(contextFor('search')));
    await waitFor(() => expect(result.current.context).toMatchObject({ data: { activeFolder: { uid: 'search' } } }));
    await act(async () => first.resolve(contextFor('payment')));
    expect(result.current.context).toMatchObject({ data: { activeFolder: { uid: 'search' } } });
  });

  test('creates a session in the active folder and updates navigation and history', async () => {
    const onNavigate = jest.fn();
    const gateway = createFixtureWorkbenchGateway({
      latencyMs: 0,
      newId: () => 'session-new',
    });
    const { result } = renderHook(() =>
      useWorkbenchController({
        gateway,
        activeFolder: fixtureFolders[2],
        onNavigate,
        onFolderChange: jest.fn(),
      })
    );
    await waitFor(() => expect(result.current.sessions.status).toBe('success'));

    await act(async () => {
      await result.current.createSession('Search 回归');
    });

    expect(onNavigate).toHaveBeenCalledWith('session-new');
    expect(result.current.sessions.status).toBe('success');
    if (result.current.sessions.status === 'success') {
      expect(result.current.sessions.data[0]).toMatchObject({
        id: 'session-new',
        title: 'Search 回归',
        folderUid: 'search',
      });
    }
  });

  test('creates an unbound session when no Folder is selected', async () => {
    const onNavigate = jest.fn();
    const gateway = createFixtureWorkbenchGateway({ latencyMs: 0, newId: () => 'session-unbound' });
    const { result } = renderHook(() => useWorkbenchController({ gateway, onNavigate, onFolderChange: jest.fn() }));
    await waitFor(() => expect(result.current.sessions.status).toBe('success'));

    await act(async () => {
      await result.current.createSession('未绑定会话');
    });

    expect(onNavigate).toHaveBeenCalledWith('session-unbound');
    await expect(gateway.openSession('session-unbound')).resolves.toMatchObject({
      session: { folderUid: '', folderTitle: '未绑定' },
    });
  });

  test('does not navigate after a create request resolves for a newer route', async () => {
    const create = deferred<OpenedSession>();
    const onNavigate = jest.fn();
    const baseGateway = createFixtureWorkbenchGateway({ latencyMs: 0 });
    const gateway: WorkbenchGateway = {
      ...baseGateway,
      createSession: jest.fn((_input, _signal) => create.promise),
    };
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId?: string }) =>
        useWorkbenchController({
          gateway,
          sessionId,
          activeFolder: fixtureFolders[1],
          onNavigate,
          onFolderChange: jest.fn(),
        }),
      { initialProps: { sessionId: 's-001' } }
    );

    let createPromise!: Promise<OpenedSession | undefined>;
    act(() => {
      createPromise = result.current.createSession('stale create');
    });
    rerender({ sessionId: 's-002' });
    await act(async () => {
      create.resolve(openedSession('session-new'));
      await createPromise;
    });

    expect(onNavigate).not.toHaveBeenCalledWith('session-new');
    expect(result.current.creating.status).toBe('idle');
  });

  test('deletes the current session and navigates to the adjacent session', async () => {
    const onNavigate = jest.fn();
    const gateway = createFixtureWorkbenchGateway({ latencyMs: 0 });
    const { result } = renderHook(() =>
      useWorkbenchController({
        gateway,
        sessionId: 's-001',
        activeFolder: fixtureFolders[1],
        onNavigate,
        onFolderChange: jest.fn(),
      })
    );
    await waitFor(() => expect(result.current.openedSession.status).toBe('success'));
    await waitFor(() => expect(result.current.sessions.status).toBe('success'));

    await act(async () => {
      await result.current.deleteCurrentSession();
    });

    expect(result.current.deleting).toEqual({ status: 'success', data: 's-001' });
    expect(result.current.sessions.status).toBe('success');
    if (result.current.sessions.status === 'success') {
      expect(result.current.sessions.data.some(({ id }) => id === 's-001')).toBe(false);
    }
    expect(onNavigate).toHaveBeenCalledWith('s-002', true);
  });

  test('does not let a late delete response take over a newer Session route', async () => {
    const deleteGate = deferred<void>();
    const baseGateway = createFixtureWorkbenchGateway({ latencyMs: 0 });
    const gateway: WorkbenchGateway = {
      ...baseGateway,
      openSession: jest.fn(async (id: string) => openedSession(id)),
      deleteSession: jest.fn(async () => deleteGate.promise),
    };
    const onNavigate = jest.fn();
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) =>
        useWorkbenchController({
          gateway,
          sessionId,
          activeFolder: fixtureFolders[1],
          onNavigate,
          onFolderChange: jest.fn(),
        }),
      { initialProps: { sessionId: 's-001' } }
    );

    await waitFor(() => expect(result.current.openedSession.status).toBe('success'));
    let deletePromise!: Promise<boolean>;
    act(() => {
      deletePromise = result.current.deleteCurrentSession();
    });
    await waitFor(() => expect(gateway.deleteSession).toHaveBeenCalledWith('s-001'));

    rerender({ sessionId: 's-002' });
    await waitFor(() => expect(gateway.openSession).toHaveBeenCalledWith('s-002', expect.any(AbortSignal)));
    await act(async () => {
      deleteGate.resolve();
      await expect(deletePromise).resolves.toBe(true);
    });

    expect(onNavigate).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.openedSession).toMatchObject({ data: { session: { id: 's-002' } } }));
  });

  test('refuses to archive while a stream is still active', async () => {
    const baseGateway = createFixtureWorkbenchGateway({ latencyMs: 0 });
    const archiveSession = jest.fn(baseGateway.archiveSession);
    const streamMessage = jest.fn(async function* (
      _input: SendMessageInput,
      signal: AbortSignal
    ): AsyncGenerator<AgentEvent> {
      yield { type: 'message_start' };
      yield { type: 'turn_started', payload: { turnId: 'turn-provider-archive' } };
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), {
          once: true,
        });
      });
    });
    const gateway: WorkbenchGateway = { ...baseGateway, archiveSession, streamMessage };
    const { result } = renderHook(() =>
      useWorkbenchController({
        gateway,
        sessionId: 's-001',
        activeFolder: fixtureFolders[1],
        onNavigate: jest.fn(),
        onFolderChange: jest.fn(),
      })
    );
    await waitFor(() => expect(result.current.openedSession.status).toBe('success'));

    let sendPromise: Promise<void> | undefined;
    act(() => {
      sendPromise = result.current.sendMessage('investigate');
    });
    await waitFor(() => expect(result.current.streaming).toBe(true));

    await act(async () => {
      await result.current.archiveCurrentSession();
    });
    expect(archiveSession).not.toHaveBeenCalled();

    await act(async () => {
      result.current.stopStreaming();
      await sendPromise;
    });
  });

  test('surfaces archive failures without an unhandled rejection', async () => {
    const baseGateway = createFixtureWorkbenchGateway({ latencyMs: 0 });
    const gateway: WorkbenchGateway = {
      ...baseGateway,
      archiveSession: jest.fn(async () => {
        throw new Error('archive unavailable');
      }),
    };
    const { result } = renderHook(() =>
      useWorkbenchController({
        gateway,
        sessionId: 's-001',
        activeFolder: fixtureFolders[1],
        onNavigate: jest.fn(),
        onFolderChange: jest.fn(),
      })
    );
    await waitFor(() => expect(result.current.openedSession.status).toBe('success'));

    await act(async () => {
      await expect(result.current.archiveCurrentSession()).resolves.toBe(false);
    });

    expect(result.current.archiveError).toBe('archive unavailable');
  });

  test('does not apply a late archive response to a newer Session route', async () => {
    const archiveGate = deferred<SessionSummary>();
    const baseGateway = createFixtureWorkbenchGateway({ latencyMs: 0 });
    const gateway: WorkbenchGateway = {
      ...baseGateway,
      openSession: jest.fn(async (id: string) => openedSession(id)),
      archiveSession: jest.fn(async () => archiveGate.promise),
    };
    const { result, rerender } = renderHook(
      ({ sessionId }: { sessionId: string }) =>
        useWorkbenchController({
          gateway,
          sessionId,
          activeFolder: fixtureFolders[1],
          onNavigate: jest.fn(),
          onFolderChange: jest.fn(),
        }),
      { initialProps: { sessionId: 's-001' } }
    );

    await waitFor(() => expect(result.current.openedSession.status).toBe('success'));
    let archivePromise!: Promise<boolean>;
    act(() => {
      archivePromise = result.current.archiveCurrentSession();
    });
    await waitFor(() => expect(gateway.archiveSession).toHaveBeenCalledWith('s-001'));

    rerender({ sessionId: 's-002' });
    await waitFor(() => expect(gateway.openSession).toHaveBeenCalledWith('s-002', expect.any(AbortSignal)));
    await act(async () => {
      archiveGate.resolve({ ...summary('s-001'), status: 'archived' });
      await expect(archivePromise).resolves.toBe(false);
    });

    await waitFor(() => expect(result.current.openedSession).toMatchObject({ data: { session: { id: 's-002' } } }));
    expect(result.current.archiveError).toBeUndefined();
  });

  test('sends a message without adding a Folder when none is selected', async () => {
    const baseGateway = createFixtureWorkbenchGateway({ latencyMs: 0 });
    const clientTurnId = '123e4567-e89b-42d3-a456-426614174000';
    const streamMessage = jest.fn(async function* (
      _input: SendMessageInput,
      _signal: AbortSignal
    ): AsyncGenerator<AgentEvent> {
      yield { type: 'message_start' };
      yield { type: 'done', payload: { turnId: 'turn-1', replayed: false } };
    });
    const openSession = jest
      .fn<Promise<OpenedSession>, [string, AbortSignal?]>()
      .mockResolvedValueOnce(openedSession('s-001'))
      .mockResolvedValue(committedSession('s-001', clientTurnId));
    const gateway: WorkbenchGateway = { ...baseGateway, openSession, streamMessage, saveSession: jest.fn() };
    const { result } = renderHook(() =>
      useWorkbenchController({ gateway, sessionId: 's-001', onNavigate: jest.fn(), onFolderChange: jest.fn() })
    );
    await waitFor(() => expect(result.current.openedSession.status).toBe('success'));

    await act(async () => {
      await result.current.sendMessage('investigate');
    });

    expect(streamMessage).toHaveBeenCalledTimes(1);
    expect(streamMessage.mock.calls[0][0]).not.toHaveProperty('activeFolder');
  });

  test('can reject a pending write without a Folder while approval stays fail-closed', async () => {
    const baseGateway = createFixtureWorkbenchGateway({ latencyMs: 0 });
    const clientTurnId = '123e4567-e89b-42d3-a456-426614174000';
    const streamMessage = jest.fn(async function* (_input: SendMessageInput): AsyncGenerator<AgentEvent> {
      yield { type: 'message_start' };
      yield {
        type: 'interrupt',
        payload: {
          id: 'checkpoint-1',
          clientTurnId,
          toolCallId: 'tool-1',
          server: 'grafana',
          tool: 'update_dashboard',
          args: '{}',
          reason: '需要审批',
          preview: ['+ panel'],
        },
      };
    });
    const resolveInterrupt = jest.fn(async function* (input: ResolveInterruptInput): AsyncGenerator<AgentEvent> {
      expect(input.activeFolder).toBeUndefined();
      yield { type: 'message_start' };
      yield { type: 'message_end', payload: {} };
      yield { type: 'done', payload: { turnId: input.request.clientTurnId, replayed: false } };
    });
    const gateway: WorkbenchGateway = { ...baseGateway, streamMessage, resolveInterrupt };
    const { result } = renderHook(() =>
      useWorkbenchController({ gateway, sessionId: 's-001', onNavigate: jest.fn(), onFolderChange: jest.fn() })
    );
    await waitFor(() => expect(result.current.openedSession.status).toBe('success'));

    await act(async () => {
      await result.current.sendMessage('write something');
    });
    await waitFor(() => expect(result.current.pendingHITL).not.toBeNull());
    await act(async () => {
      await result.current.resolveHITL('approved');
    });
    expect(resolveInterrupt).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.resolveHITL('rejected', '范围不明确');
    });
    expect(resolveInterrupt).toHaveBeenCalledTimes(1);
    expect(result.current.pendingHITL).toBeNull();
  });

  test('keeps approval fail-closed for a View-only Folder', async () => {
    const baseGateway = createFixtureWorkbenchGateway({ latencyMs: 0 });
    const clientTurnId = '123e4567-e89b-42d3-a456-426614174000';
    const streamMessage = jest.fn(async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'interrupt', payload: { ...pendingInterrupt(), clientTurnId } };
    });
    const resolveInterrupt = jest.fn(async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'done', payload: { turnId: clientTurnId, replayed: false } };
    });
    const gateway: WorkbenchGateway = { ...baseGateway, streamMessage, resolveInterrupt };
    const { result } = renderHook(() =>
      useWorkbenchController({
        gateway,
        sessionId: 's-001',
        activeFolder: fixtureFolders[0],
        onNavigate: jest.fn(),
        onFolderChange: jest.fn(),
      })
    );
    await waitFor(() => expect(result.current.openedSession.status).toBe('success'));
    await act(async () => {
      await result.current.sendMessage('write something');
    });
    await waitFor(() => expect(result.current.pendingHITL).not.toBeNull());

    await act(async () => {
      await result.current.resolveHITL('approved');
    });
    expect(resolveInterrupt).not.toHaveBeenCalled();
  });

  test('keeps a pending approval bound to the Folder that created it', async () => {
    const baseGateway = createFixtureWorkbenchGateway({ latencyMs: 0 });
    const clientTurnId = '123e4567-e89b-42d3-a456-426614174000';
    const streamMessage = jest.fn(async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'interrupt', payload: { ...pendingInterrupt(), clientTurnId } };
    });
    const resolveInterrupt = jest.fn(async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'done', payload: { turnId: clientTurnId, replayed: false } };
    });
    const gateway: WorkbenchGateway = { ...baseGateway, streamMessage, resolveInterrupt };
    const { result, rerender } = renderHook(
      ({ activeFolder }) =>
        useWorkbenchController({
          gateway,
          sessionId: 's-001',
          activeFolder,
          onNavigate: jest.fn(),
          onFolderChange: jest.fn(),
        }),
      { initialProps: { activeFolder: fixtureFolders[1] } }
    );
    await waitFor(() => expect(result.current.openedSession.status).toBe('success'));
    await act(async () => {
      await result.current.sendMessage('write something');
    });
    await waitFor(() => expect(result.current.pendingHITL).not.toBeNull());
    expect(result.current.pendingHITLFolderUid).toBe('payment');

    rerender({ activeFolder: fixtureFolders[2] });
    await act(async () => {
      await result.current.resolveHITL('approved');
    });
    expect(resolveInterrupt).not.toHaveBeenCalled();

    rerender({ activeFolder: fixtureFolders[1] });
    await act(async () => {
      await result.current.resolveHITL('approved');
    });
    expect(resolveInterrupt).toHaveBeenCalledTimes(1);
  });

  test('restores a pending HITL request when resume fails', async () => {
    const baseGateway = createFixtureWorkbenchGateway({ latencyMs: 0 });
    const streamMessage = jest.fn(async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'interrupt', payload: pendingInterrupt() };
    });
    const resolveInterrupt = jest.fn(async function* (): AsyncGenerator<AgentEvent> {
      throw new Error('resume unavailable');
    });
    const gateway: WorkbenchGateway = { ...baseGateway, streamMessage, resolveInterrupt };
    const { result } = renderHook(() =>
      useWorkbenchController({
        gateway,
        sessionId: 's-001',
        activeFolder: fixtureFolders[1],
        onNavigate: jest.fn(),
        onFolderChange: jest.fn(),
      })
    );

    await waitFor(() => expect(result.current.openedSession.status).toBe('success'));
    await act(async () => result.current.sendMessage('需要审批'));
    await waitFor(() => expect(result.current.pendingHITL?.id).toBe('checkpoint-1'));

    await act(async () => result.current.resolveHITL('rejected', '暂不执行'));

    expect(result.current.pendingHITL?.id).toBe('checkpoint-1');
    expect(result.current.hitlVisible).toBe(true);
  });

  test('registers a new HITL checkpoint and rejects a callback captured for the previous one', async () => {
    const baseGateway = createFixtureWorkbenchGateway({ latencyMs: 0 });
    const streamMessage = jest.fn(async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'interrupt', payload: pendingInterrupt() };
    });
    const resolveInterrupt = jest.fn(async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'interrupt', payload: { ...pendingInterrupt(), id: 'checkpoint-2', toolCallId: 'tool-2' } };
    });
    const gateway: WorkbenchGateway = { ...baseGateway, streamMessage, resolveInterrupt };
    const { result } = renderHook(() =>
      useWorkbenchController({
        gateway,
        sessionId: 's-001',
        activeFolder: fixtureFolders[1],
        onNavigate: jest.fn(),
        onFolderChange: jest.fn(),
      })
    );

    await waitFor(() => expect(result.current.openedSession.status).toBe('success'));
    await act(async () => result.current.sendMessage('需要审批'));
    await waitFor(() => expect(result.current.pendingHITL?.id).toBe('checkpoint-1'));
    const resolveFirstCheckpoint = result.current.resolveHITL;

    await act(async () => resolveFirstCheckpoint('rejected', '继续下一步'));
    await waitFor(() => expect(result.current.pendingHITL?.id).toBe('checkpoint-2'));
    await act(async () => resolveFirstCheckpoint('rejected', '过期回调'));

    expect(resolveInterrupt).toHaveBeenCalledTimes(1);
  });

  test('ignores late HITL events after the Session route changes', async () => {
    const baseGateway = createFixtureWorkbenchGateway({ latencyMs: 0 });
    const clientTurnId = '123e4567-e89b-42d3-a456-426614174000';
    const lateEvent = deferred<AgentEvent>();
    const openSession = jest
      .fn<Promise<OpenedSession>, [string, AbortSignal?]>()
      .mockResolvedValueOnce(openedSession('s-001'))
      .mockResolvedValue(openedSession('s-002'));
    const streamMessage = jest.fn(async function* (): AsyncGenerator<AgentEvent> {
      yield { type: 'interrupt', payload: { ...pendingInterrupt(), clientTurnId } };
    });
    const resolveInterrupt = jest.fn(async function* (): AsyncGenerator<AgentEvent> {
      yield await lateEvent.promise;
    });
    const gateway: WorkbenchGateway = { ...baseGateway, openSession, streamMessage, resolveInterrupt };
    const { result, rerender } = renderHook(
      ({ sessionId }) =>
        useWorkbenchController({
          gateway,
          sessionId,
          activeFolder: fixtureFolders[1],
          onNavigate: jest.fn(),
          onFolderChange: jest.fn(),
        }),
      { initialProps: { sessionId: 's-001' } }
    );

    await waitFor(() => expect(result.current.openedSession.status).toBe('success'));
    await act(async () => {
      await result.current.sendMessage('需要审批');
    });
    await waitFor(() => expect(result.current.pendingHITL).not.toBeNull());

    let resolvePromise: Promise<void> | undefined;
    act(() => {
      resolvePromise = result.current.resolveHITL('rejected', '取消');
    });
    await waitFor(() => expect(result.current.streaming).toBe(true));
    rerender({ sessionId: 's-002' });
    await waitFor(() => expect(result.current.openedSession).toMatchObject({ data: { session: { id: 's-002' } } }));

    await act(async () => {
      lateEvent.resolve({ type: 'message_delta', payload: { delta: '旧会话事件' } });
      await resolvePromise;
    });

    expect(result.current.openedSession).toMatchObject({ data: { session: { id: 's-002' } } });
    if (result.current.openedSession.status === 'success') {
      expect(result.current.openedSession.data.messages).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ content: expect.stringContaining('旧会话事件') })])
      );
    }
  });

  test('does not let an older HITL stream update or clear a newer stream', async () => {
    const baseGateway = createFixtureWorkbenchGateway({ latencyMs: 0 });
    const clientTurnId = '123e4567-e89b-42d3-a456-426614174000';
    const firstGate = deferred<void>();
    const firstWaiting = deferred<void>();
    const secondGate = deferred<void>();
    const firstFinished = deferred<void>();
    let resolveCall = 0;
    const openSession = jest.fn(async () => openedSession('s-001'));
    const streamMessage = jest.fn(async function* (_input: SendMessageInput): AsyncGenerator<AgentEvent> {
      yield { type: 'interrupt', payload: { ...pendingInterrupt(), clientTurnId } };
    });
    const resolveInterrupt = jest.fn((_input: ResolveInterruptInput): AsyncIterable<AgentEvent> => {
      const call = resolveCall++;
      return (async function* (): AsyncGenerator<AgentEvent> {
        if (call === 0) {
          try {
            yield { type: 'message_start' };
            firstWaiting.resolve();
            await firstGate.promise;
            yield { type: 'message_delta', payload: { delta: '旧流事件' } };
          } finally {
            firstFinished.resolve();
          }
          return;
        }
        yield { type: 'message_start' };
        await secondGate.promise;
        yield { type: 'message_delta', payload: { delta: '新流事件' } };
        yield { type: 'done', payload: { turnId: clientTurnId, replayed: false } };
      })();
    });
    const gateway: WorkbenchGateway = {
      ...baseGateway,
      openSession,
      streamMessage,
      resolveInterrupt,
      saveSession: jest.fn().mockResolvedValue(undefined),
    };
    const { result } = renderHook(() =>
      useWorkbenchController({
        gateway,
        sessionId: 's-001',
        activeFolder: fixtureFolders[1],
        onNavigate: jest.fn(),
        onFolderChange: jest.fn(),
      })
    );

    await waitFor(() => expect(result.current.openedSession.status).toBe('success'));
    await act(async () => {
      await result.current.sendMessage('需要审批');
    });
    await waitFor(() => expect(result.current.pendingHITL).not.toBeNull());

    const resolve = result.current.resolveHITL;
    let firstPromise!: Promise<void>;
    let secondPromise!: Promise<void>;
    act(() => {
      firstPromise = resolve('rejected', '第一次');
    });
    await act(async () => firstWaiting.promise);
    act(() => {
      secondPromise = resolve('rejected', '第二次');
    });
    await waitFor(() => expect(resolveInterrupt).toHaveBeenCalledTimes(2));

    await act(async () => {
      firstGate.resolve();
      await firstFinished.promise;
    });
    expect(result.current.streaming).toBe(true);
    if (result.current.openedSession.status === 'success') {
      expect(result.current.openedSession.data.messages).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ content: expect.stringContaining('旧流事件') })])
      );
    }

    await act(async () => {
      secondGate.resolve();
      await Promise.all([firstPromise, secondPromise]);
    });
    expect(result.current.streaming).toBe(false);
    if (result.current.openedSession.status === 'success') {
      expect(result.current.openedSession.data.messages).toEqual(
        expect.arrayContaining([expect.objectContaining({ content: expect.stringContaining('新流事件') })])
      );
    }
  });

  test('reconciles a completed stream from the persisted Session aggregate', async () => {
    const baseGateway = createFixtureWorkbenchGateway({ latencyMs: 0 });
    const persisted = committedSession('s-001', '123e4567-e89b-42d3-a456-426614174000');
    const openSession = jest
      .fn<Promise<OpenedSession>, [string, AbortSignal?]>()
      .mockResolvedValueOnce(openedSession('s-001'))
      .mockResolvedValue(persisted);
    const streamMessage = jest.fn(async function* (
      _input: SendMessageInput,
      _signal: AbortSignal
    ): AsyncGenerator<AgentEvent> {
      yield { type: 'message_start' };
      yield { type: 'message_delta', payload: { delta: 'optimistic' } };
      yield { type: 'message_end', payload: {} };
      yield { type: 'done', payload: { turnId: 'turn-1', replayed: false } };
    });
    const gateway: WorkbenchGateway = { ...baseGateway, openSession, streamMessage, saveSession: jest.fn() };
    const { result } = renderHook(() =>
      useWorkbenchController({
        gateway,
        sessionId: 's-001',
        activeFolder: fixtureFolders[1],
        onNavigate: jest.fn(),
        onFolderChange: jest.fn(),
      })
    );
    await waitFor(() => expect(result.current.openedSession.status).toBe('success'));

    await act(async () => {
      await result.current.sendMessage('investigate');
    });

    expect(streamMessage.mock.calls[0][0].clientTurnId).toBe('123e4567-e89b-42d3-a456-426614174000');
    expect(openSession).toHaveBeenCalledTimes(2);
    expect(result.current.openedSession).toMatchObject({
      status: 'success',
      data: { messages: [{ content: 'persisted user' }, { content: 'persisted assistant' }] },
    });
  });

  test('preserves a canvas edit made while a response is streaming', async () => {
    const streamGate = deferred<void>();
    const baseGateway = createFixtureWorkbenchGateway({ latencyMs: 0 });
    const streamMessage = jest.fn(async function* (
      _input: SendMessageInput,
      signal: AbortSignal
    ): AsyncGenerator<AgentEvent> {
      yield { type: 'message_start' };
      yield { type: 'turn_started', payload: { turnId: 'turn-provider-canvas' } };
      await streamGate.promise;
      yield { type: 'message_delta', payload: { delta: 'partial' } };
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), {
          once: true,
        });
      });
    });
    const gateway: WorkbenchGateway = { ...baseGateway, streamMessage };
    const { result } = renderHook(() =>
      useWorkbenchController({
        gateway,
        sessionId: 's-001',
        activeFolder: fixtureFolders[1],
        onNavigate: jest.fn(),
        onFolderChange: jest.fn(),
      })
    );
    await waitFor(() => expect(result.current.openedSession.status).toBe('success'));

    let sendPromise: Promise<void> | undefined;
    act(() => {
      sendPromise = result.current.sendMessage('investigate');
    });
    await waitFor(() => expect(result.current.streaming).toBe(true));

    const chart = {
      id: 'chart-during-stream',
      title: '流中固定的图表',
      description: '用户编辑',
      visualization: 'line' as const,
      renderMode: 'fixture' as const,
    };
    act(() => {
      result.current.updateCanvas((canvas) => ({ ...canvas, charts: [...canvas.charts, chart] }));
    });
    await waitFor(() =>
      expect(result.current.openedSession).toMatchObject({
        data: { canvas: { charts: expect.arrayContaining([chart]) } },
      })
    );

    await act(async () => streamGate.resolve(undefined));
    await waitFor(() =>
      expect(result.current.openedSession).toMatchObject({
        data: {
          messages: expect.arrayContaining([expect.objectContaining({ content: expect.stringContaining('partial') })]),
        },
      })
    );
    expect(result.current.openedSession).toMatchObject({
      data: { canvas: { charts: expect.arrayContaining([chart]) } },
    });

    await act(async () => {
      result.current.stopStreaming();
      await sendPromise;
    });
  });

  test('bounds busy retries and manual retry reuses the failed command id', async () => {
    const baseGateway = createFixtureWorkbenchGateway({ latencyMs: 0 });
    const inputs: SendMessageInput[] = [];
    let streamCalls = 0;
    const streamMessage = jest.fn(async function* (
      input: SendMessageInput,
      _signal: AbortSignal
    ): AsyncGenerator<AgentEvent> {
      inputs.push(input);
      streamCalls += 1;
      if (streamCalls <= 4) {
        throw new ResourceRequestError(409, 2006, 'busy', 0);
      }
      yield { type: 'message_start' };
      yield { type: 'message_delta', payload: { delta: 'replayed' } };
      yield { type: 'message_end', payload: {} };
      yield { type: 'done', payload: { turnId: 'turn-1', replayed: false } };
    });
    const openSession = jest.fn(async () =>
      streamCalls >= 5 ? committedSession('s-001', '123e4567-e89b-42d3-a456-426614174000') : openedSession('s-001')
    );
    const gateway: WorkbenchGateway = { ...baseGateway, openSession, streamMessage, saveSession: jest.fn() };
    const { result } = renderHook(() =>
      useWorkbenchController({
        gateway,
        sessionId: 's-001',
        activeFolder: fixtureFolders[1],
        onNavigate: jest.fn(),
        onFolderChange: jest.fn(),
      })
    );
    await waitFor(() => expect(result.current.openedSession.status).toBe('success'));

    await act(async () => {
      await result.current.sendMessage('investigate');
    });

    expect(streamMessage).toHaveBeenCalledTimes(4);
    expect(result.current.lastFailedInput).toBe('investigate');

    await act(async () => {
      await result.current.retryLastMessage();
    });

    expect(streamMessage).toHaveBeenCalledTimes(5);
    expect(new Set(inputs.map(({ clientTurnId }) => clientTurnId))).toEqual(
      new Set(['123e4567-e89b-42d3-a456-426614174000'])
    );
    expect(result.current.lastFailedInput).toBeUndefined();
  });

  test('cancels an active stream when the Session route changes', async () => {
    const baseGateway = createFixtureWorkbenchGateway({ latencyMs: 0 });
    let streamSignal: AbortSignal | undefined;
    const streamMessage = jest.fn(async function* (
      _input: SendMessageInput,
      signal: AbortSignal
    ): AsyncGenerator<AgentEvent> {
      streamSignal = signal;
      yield { type: 'message_start' };
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), {
          once: true,
        });
      });
    });
    const gateway: WorkbenchGateway = { ...baseGateway, streamMessage };
    const { result, rerender } = renderHook(
      ({ sessionId }) =>
        useWorkbenchController({
          gateway,
          sessionId,
          activeFolder: fixtureFolders[1],
          onNavigate: jest.fn(),
          onFolderChange: jest.fn(),
        }),
      { initialProps: { sessionId: 's-001' } }
    );
    await waitFor(() => expect(result.current.openedSession.status).toBe('success'));

    act(() => {
      void result.current.sendMessage('investigate');
    });
    await waitFor(() => expect(streamMessage).toHaveBeenCalled());
    rerender({ sessionId: 's-002' });

    await waitFor(() => expect(streamSignal?.aborted).toBe(true));
  });

  test('reconciles after Stop and restores a Turn committed before cancellation', async () => {
    const baseGateway = createFixtureWorkbenchGateway({ latencyMs: 0 });
    const cancelTurn = jest.fn(baseGateway.cancelTurn);
    const openSession = jest
      .fn<Promise<OpenedSession>, [string, AbortSignal?]>()
      .mockResolvedValueOnce(openedSession('s-001'))
      .mockResolvedValue(committedSession('s-001', '123e4567-e89b-42d3-a456-426614174000'));
    const streamMessage = jest.fn(async function* (
      _input: SendMessageInput,
      signal: AbortSignal
    ): AsyncGenerator<AgentEvent> {
      yield { type: 'message_start' };
      yield { type: 'turn_started', payload: { turnId: 'turn-provider-1' } };
      yield { type: 'message_delta', payload: { delta: 'partial' } };
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), {
          once: true,
        });
      });
    });
    const gateway: WorkbenchGateway = {
      ...baseGateway,
      openSession,
      streamMessage,
      cancelTurn,
      saveSession: jest.fn(),
    };
    const { result } = renderHook(() =>
      useWorkbenchController({
        gateway,
        sessionId: 's-001',
        activeFolder: fixtureFolders[1],
        onNavigate: jest.fn(),
        onFolderChange: jest.fn(),
      })
    );
    await waitFor(() => expect(result.current.openedSession.status).toBe('success'));
    let sendPromise: Promise<void> | undefined;
    act(() => {
      sendPromise = result.current.sendMessage('investigate');
    });
    await waitFor(() =>
      expect(result.current.openedSession).toMatchObject({
        data: { messages: expect.arrayContaining([expect.objectContaining({ content: 'partial' })]) },
      })
    );

    await act(async () => {
      result.current.stopStreaming();
      await sendPromise;
    });

    expect(cancelTurn).toHaveBeenCalledWith('s-001', 'turn-provider-1', 'cancel-123e4567-e89b-42d3-a456-426614174000');
    expect(openSession).toHaveBeenCalledTimes(2);
    expect(result.current.openedSession).toMatchObject({
      data: { messages: [{ content: 'persisted user' }, { content: 'persisted assistant' }] },
    });
    expect(result.current.lastFailedInput).toBeUndefined();
  });

  test('keeps the stream connected when Turn cancellation is rejected', async () => {
    const baseGateway = createFixtureWorkbenchGateway({ latencyMs: 0 });
    const cancelTurn = jest.fn().mockRejectedValue(new Error('cancel unavailable'));
    let streamSignal: AbortSignal | undefined;
    const streamMessage = jest.fn(async function* (
      _input: SendMessageInput,
      signal: AbortSignal
    ): AsyncGenerator<AgentEvent> {
      streamSignal = signal;
      yield { type: 'message_start' };
      yield { type: 'turn_started', payload: { turnId: 'turn-provider-1' } };
      yield { type: 'message_delta', payload: { delta: 'partial' } };
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')), {
          once: true,
        });
      });
    });
    const gateway: WorkbenchGateway = { ...baseGateway, streamMessage, cancelTurn };
    const { result, unmount } = renderHook(() =>
      useWorkbenchController({
        gateway,
        sessionId: 's-001',
        activeFolder: fixtureFolders[1],
        onNavigate: jest.fn(),
        onFolderChange: jest.fn(),
      })
    );
    await waitFor(() => expect(result.current.openedSession.status).toBe('success'));
    act(() => {
      void result.current.sendMessage('investigate');
    });
    await waitFor(() =>
      expect(result.current.openedSession).toMatchObject({
        data: { messages: expect.arrayContaining([expect.objectContaining({ content: 'partial' })]) },
      })
    );

    await act(async () => {
      result.current.stopStreaming();
      await Promise.resolve();
    });

    expect(cancelTurn).toHaveBeenCalledTimes(1);
    expect(streamSignal?.aborted).toBe(false);
    expect(result.current.streaming).toBe(true);
    unmount();
  });
});

function openedSession(id: string): OpenedSession {
  return {
    session: summary(id),
    messages: [],
    canvas: { visible: true, layout: 'grid-2x2', charts: [] },
  };
}

function summary(id: string): SessionSummary {
  return {
    id,
    title: `Session ${id}`,
    folderUid: 'infra',
    folderTitle: 'Infra',
    status: 'active',
    visibility: 'private',
    updatedAt: '2026-07-25T10:00:00.000Z',
    messageCount: 0,
    preview: '',
  };
}

function committedSession(id: string, clientTurnId: string): OpenedSession {
  return {
    ...openedSession(id),
    messages: [
      { id: 'user-1', clientTurnId, role: 'user', content: 'persisted user' },
      {
        id: 'assistant-1',
        clientTurnId,
        role: 'assistant',
        content: 'persisted assistant',
        streamStatus: 'complete',
      },
    ],
  };
}

function contextFor(folderUid: string): WorkbenchContext {
  const folder = fixtureFolders.find(({ uid }) => uid === folderUid) ?? fixtureFolders[0];
  return {
    activeFolder: folder,
    sharedFolder: fixtureFolders[0],
    injectedServices: [],
    skills: [],
    recent: [],
    cost: { llmCalls: 0, toolRounds: 0, maxToolRounds: 8, tokensIn: '0', tokensOut: '0', latency: '0ms' },
  };
}

function pendingInterrupt() {
  return {
    id: 'checkpoint-1',
    clientTurnId: '123e4567-e89b-42d3-a456-426614174000',
    toolCallId: 'tool-1',
    server: 'grafana',
    tool: 'update_dashboard',
    args: '{}',
    reason: '需要审批',
    preview: ['+ panel'],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
