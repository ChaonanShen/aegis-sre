import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Folder } from '../../../app/model';
import {
  MessageAttachment,
  OpenedSession,
  PendingHITL,
  ResourceRequestError,
  ResolveInterruptInput,
  SendMessageInput,
  SessionSummary,
  WorkbenchContext,
  WorkbenchMessage,
} from '../model';
import { WorkbenchGateway } from '../ports/WorkbenchGateway';
import { newClientTurnId } from './clientTurnId';
import { applyAgentEvent, markMessageStopped } from './workbenchReducer';

export type AsyncState<T> =
  { status: 'idle' } | { status: 'loading' } | { status: 'success'; data: T } | { status: 'error'; error: Error };

interface WorkbenchControllerOptions {
  gateway: WorkbenchGateway;
  sessionId?: string;
  activeFolder?: Folder;
  onNavigate: (sessionId?: string, replace?: boolean) => void;
  onFolderChange: (folderUid: string) => void;
}

interface FailedCommand {
  input: SendMessageInput;
  assistantMessageId: string;
  previousMessageCount: number;
}

const maxBusyRetries = 3;
const maxBusyWaitSeconds = 15;

let messageCounter = 0;

export function useWorkbenchController({
  gateway,
  sessionId,
  activeFolder,
  onNavigate,
  onFolderChange,
}: WorkbenchControllerOptions) {
  const [sessions, setSessions] = useState<AsyncState<SessionSummary[]>>({ status: 'idle' });
  const [openedSession, setOpenedSessionState] = useState<AsyncState<OpenedSession>>({ status: 'idle' });
  const [context, setContext] = useState<AsyncState<WorkbenchContext>>({ status: 'idle' });
  const [creating, setCreating] = useState<AsyncState<OpenedSession>>({ status: 'idle' });
  const [deleting, setDeleting] = useState<AsyncState<string>>({ status: 'idle' });
  const [archiveError, setArchiveError] = useState<string>();
  const [streaming, setStreaming] = useState(false);
  const [pendingHITL, setPendingHITL] = useState<PendingHITL | null>(null);
  const [hitlVisible, setHitlVisible] = useState(false);
  const [lastFailedInput, setLastFailedInput] = useState<string>();
  const sessionsStateRef = useRef<AsyncState<SessionSummary[]>>({ status: 'idle' });
  const failedCommandRef = useRef<FailedCommand>();
  const openedRef = useRef<OpenedSession>();
  const routeSessionIdRef = useRef(sessionId);
  const openedSessionIdRef = useRef<string>();
  const pendingHITLSessionIdRef = useRef<string>();
  const pendingHITLRequestIdRef = useRef<string>();
  const pendingHITLFolderUidRef = useRef<string>();
  const failedCommandSessionIdRef = useRef<string>();
  const streamSessionIdRef = useRef<string>();
  const activeTurnIdRef = useRef<string>();
  const activeClientTurnIdRef = useRef<string>();
  const archiveErrorSessionIdRef = useRef<string>();
  const streamControllerRef = useRef<AbortController>();
  const reconcileControllerRef = useRef<AbortController>();
  const createControllerRef = useRef<AbortController>();
  const createRequestRef = useRef(0);
  const mountedRef = useRef(true);
  const sessionsControllerRef = useRef<AbortController>();
  const sessionsRefreshTimeoutRef = useRef<number>();
  const assistantMessageIdRef = useRef<string>();
  const openRequestRef = useRef(0);
  const sessionsRequestRef = useRef(0);
  const contextRequestRef = useRef(0);
  const contextFolderUidRef = useRef<string>();
  const activeFolderUidRef = useRef(activeFolder?.uid);
  const routeVersionRef = useRef(0);
  const streamRunRef = useRef(0);
  const stopRequestedRef = useRef(false);

  // Keep the scope check synchronous with render so a retained retry callback
  // cannot commit a response for a Folder that is no longer active.
  activeFolderUidRef.current = activeFolder?.uid;
  sessionsStateRef.current = sessions;

  // Effects run after paint. Clear imperative handles during the route render
  // so actions cannot target the previously opened Session in that interval.
  if (routeSessionIdRef.current !== sessionId) {
    routeSessionIdRef.current = sessionId;
    routeVersionRef.current += 1;
    openedRef.current = undefined;
    failedCommandRef.current = undefined;
    pendingHITLSessionIdRef.current = undefined;
    pendingHITLRequestIdRef.current = undefined;
    pendingHITLFolderUidRef.current = undefined;
    failedCommandSessionIdRef.current = undefined;
    archiveErrorSessionIdRef.current = undefined;
    activeTurnIdRef.current = undefined;
    activeClientTurnIdRef.current = undefined;
  }

  const setOpenedSession = useCallback((state: AsyncState<OpenedSession>) => {
    const stateSessionId = state.status === 'success' ? state.data.session.id : routeSessionIdRef.current;
    if (state.status === 'success' && stateSessionId !== routeSessionIdRef.current) {
      return;
    }
    openedSessionIdRef.current = stateSessionId;
    openedRef.current = state.status === 'success' ? state.data : undefined;
    setOpenedSessionState(state);
  }, []);

  const loadSessions = useCallback(async () => {
    if (sessionsRefreshTimeoutRef.current !== undefined) {
      window.clearTimeout(sessionsRefreshTimeoutRef.current);
      sessionsRefreshTimeoutRef.current = undefined;
    }
    const request = ++sessionsRequestRef.current;
    const controller = new AbortController();
    sessionsControllerRef.current?.abort();
    sessionsControllerRef.current = controller;
    setSessions({ status: 'loading' });
    try {
      const data = await gateway.listSessions(controller.signal);
      if (request === sessionsRequestRef.current && !controller.signal.aborted) {
        setSessions({ status: 'success', data });
      }
    } catch (error) {
      if (request === sessionsRequestRef.current && !controller.signal.aborted && !isAbortError(error)) {
        setSessions({ status: 'error', error: toError(error) });
      }
    } finally {
      if (sessionsControllerRef.current === controller) {
        sessionsControllerRef.current = undefined;
      }
    }
  }, [gateway]);

  const invalidateSessions = useCallback(() => {
    sessionsRequestRef.current += 1;
    sessionsControllerRef.current?.abort();
    if (sessionsStateRef.current.status === 'loading' && sessionsRefreshTimeoutRef.current === undefined) {
      sessionsRefreshTimeoutRef.current = window.setTimeout(() => {
        sessionsRefreshTimeoutRef.current = undefined;
        void loadSessions();
      }, 0);
    }
  }, [loadSessions]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void loadSessions(), 0);
    return () => {
      window.clearTimeout(timeout);
      sessionsRequestRef.current += 1;
      sessionsControllerRef.current?.abort();
      if (sessionsRefreshTimeoutRef.current !== undefined) {
        window.clearTimeout(sessionsRefreshTimeoutRef.current);
        sessionsRefreshTimeoutRef.current = undefined;
      }
    };
  }, [loadSessions]);

  useEffect(() => {
    if (sessionId || sessions.status !== 'success' || sessions.data.length === 0) {
      return;
    }
    const timeout = window.setTimeout(() => onNavigate(sessions.data[0].id, true), 0);
    return () => window.clearTimeout(timeout);
  }, [onNavigate, sessionId, sessions]);

  const loadOpenedSession = useCallback(
    async (id: string, signal?: AbortSignal) => {
      if (routeSessionIdRef.current !== id) {
        return;
      }
      const request = ++openRequestRef.current;
      openedSessionIdRef.current = id;
      setOpenedSession({ status: 'loading' });
      setPendingHITL(null);
      setHitlVisible(false);
      pendingHITLSessionIdRef.current = undefined;
      pendingHITLRequestIdRef.current = undefined;
      pendingHITLFolderUidRef.current = undefined;
      failedCommandRef.current = undefined;
      failedCommandSessionIdRef.current = undefined;
      setLastFailedInput(undefined);
      try {
        const opened = await gateway.openSession(id, signal);
        if (request === openRequestRef.current && routeSessionIdRef.current === id) {
          setOpenedSession({ status: 'success', data: opened });
        }
      } catch (error) {
        if (request === openRequestRef.current && routeSessionIdRef.current === id && !isAbortError(error)) {
          setOpenedSession({ status: 'error', error: toError(error) });
        }
      }
    },
    [gateway, setOpenedSession]
  );

  useEffect(() => {
    if (!sessionId) {
      openRequestRef.current += 1;
      return;
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => void loadOpenedSession(sessionId, controller.signal), 0);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
      openRequestRef.current += 1;
    };
  }, [loadOpenedSession, sessionId]);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      createRequestRef.current += 1;
      createControllerRef.current?.abort();
      createControllerRef.current = undefined;
    };
  }, []);

  useEffect(
    () => () => {
      // A route change must invalidate a create request before its gateway
      // promise can navigate the replacement route.
      const creating = createControllerRef.current !== undefined;
      createRequestRef.current += 1;
      createControllerRef.current?.abort();
      createControllerRef.current = undefined;
      if (creating && mountedRef.current) {
        setCreating({ status: 'idle' });
      }
      streamRunRef.current += 1;
      stopRequestedRef.current = false;
      streamControllerRef.current?.abort();
      reconcileControllerRef.current?.abort();
    },
    [sessionId]
  );

  const loadContext = useCallback(
    async (folderUid: string, signal?: AbortSignal) => {
      const request = ++contextRequestRef.current;
      contextFolderUidRef.current = folderUid;
      setContext({ status: 'loading' });
      try {
        const data = await gateway.getContext(folderUid, signal);
        if (request === contextRequestRef.current && activeFolderUidRef.current === folderUid && !signal?.aborted) {
          setContext({ status: 'success', data });
        }
      } catch (error) {
        if (
          request === contextRequestRef.current &&
          activeFolderUidRef.current === folderUid &&
          !signal?.aborted &&
          !isAbortError(error)
        ) {
          setContext({ status: 'error', error: toError(error) });
        }
      }
    },
    [gateway]
  );

  const activeFolderUid = activeFolder?.uid;

  useEffect(() => {
    if (!activeFolderUid) {
      contextRequestRef.current += 1;
      contextFolderUidRef.current = undefined;
      return;
    }
    const folderUid = activeFolderUid;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => void loadContext(folderUid, controller.signal), 0);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
      contextRequestRef.current += 1;
    };
  }, [activeFolderUid, loadContext]);

  const publishOpened = useCallback(
    (opened: OpenedSession) => {
      if (routeSessionIdRef.current !== opened.session.id) {
        return;
      }
      invalidateSessions();
      openedSessionIdRef.current = opened.session.id;
      openedRef.current = opened;
      setOpenedSessionState({ status: 'success', data: opened });
      setSessions((current) =>
        current.status === 'success'
          ? {
              status: 'success',
              data: current.data.map((summary) => (summary.id === opened.session.id ? opened.session : summary)),
            }
          : current
      );
    },
    [invalidateSessions]
  );

  const createSession = useCallback(
    async (title: string) => {
      const request = ++createRequestRef.current;
      const startedRouteVersion = routeVersionRef.current;
      const startedRouteSessionId = routeSessionIdRef.current;
      const startedFolderUid = activeFolder?.uid;
      const controller = new AbortController();
      createControllerRef.current?.abort();
      createControllerRef.current = controller;
      setCreating({ status: 'loading' });
      try {
        const created = await gateway.createSession(
          { title, ...(activeFolder ? { folder: activeFolder } : {}) },
          controller.signal
        );
        const scopeIsCurrent =
          request === createRequestRef.current &&
          mountedRef.current &&
          !controller.signal.aborted &&
          startedRouteVersion === routeVersionRef.current &&
          startedRouteSessionId === routeSessionIdRef.current &&
          startedFolderUid === activeFolderUidRef.current;
        if (!scopeIsCurrent) {
          return undefined;
        }
        invalidateSessions();
        setCreating({ status: 'success', data: created });
        setSessions((current) => ({
          status: 'success',
          data:
            current.status === 'success'
              ? [created.session, ...current.data.filter(({ id }) => id !== created.session.id)]
              : [created.session],
        }));
        onNavigate(created.session.id);
        return created;
      } catch (error) {
        if (
          request === createRequestRef.current &&
          mountedRef.current &&
          !controller.signal.aborted &&
          startedRouteVersion === routeVersionRef.current &&
          startedRouteSessionId === routeSessionIdRef.current &&
          startedFolderUid === activeFolderUidRef.current &&
          !isAbortError(error)
        ) {
          setCreating({ status: 'error', error: toError(error) });
        }
        return undefined;
      } finally {
        if (createControllerRef.current === controller) {
          createControllerRef.current = undefined;
          if (
            request === createRequestRef.current &&
            mountedRef.current &&
            (startedRouteVersion !== routeVersionRef.current ||
              startedRouteSessionId !== routeSessionIdRef.current ||
              startedFolderUid !== activeFolderUidRef.current)
          ) {
            setCreating({ status: 'idle' });
          }
        }
      }
    },
    [activeFolder, gateway, invalidateSessions, onNavigate]
  );

  const rememberFailedCommand = useCallback((command: FailedCommand) => {
    failedCommandRef.current = command;
    failedCommandSessionIdRef.current = command.input.sessionId;
    setLastFailedInput(command.input.input);
  }, []);

  const reconcileCommand = useCallback(
    async (command: FailedCommand, runID: number): Promise<boolean> => {
      const controller = new AbortController();
      reconcileControllerRef.current?.abort();
      reconcileControllerRef.current = controller;
      try {
        const persisted = await gateway.openSession(command.input.sessionId, controller.signal);
        if (runID !== streamRunRef.current || controller.signal.aborted) {
          return false;
        }
        const previousMessageCount = command.previousMessageCount;
        const committed = persisted.messages.some(
          ({ role, streamStatus }, index) =>
            index >= previousMessageCount && role === 'assistant' && streamStatus === 'complete'
        );
        if (committed) {
          publishOpened(persisted);
          failedCommandRef.current = undefined;
          failedCommandSessionIdRef.current = undefined;
          setLastFailedInput(undefined);
        }
        return committed;
      } catch (error) {
        if (!isAbortError(error) && runID === streamRunRef.current) {
          rememberFailedCommand(command);
        }
        return false;
      } finally {
        if (reconcileControllerRef.current === controller) {
          reconcileControllerRef.current = undefined;
        }
      }
    },
    [gateway, publishOpened, rememberFailedCommand]
  );

  const runCommand = useCallback(
    async (command: FailedCommand, initial: OpenedSession) => {
      const runID = ++streamRunRef.current;
      const controller = new AbortController();
      streamControllerRef.current?.abort();
      reconcileControllerRef.current?.abort();
      streamControllerRef.current = controller;
      streamSessionIdRef.current = command.input.sessionId;
      activeClientTurnIdRef.current = command.input.clientTurnId;
      activeTurnIdRef.current = undefined;
      assistantMessageIdRef.current = command.assistantMessageId;
      stopRequestedRef.current = false;
      failedCommandRef.current = undefined;
      failedCommandSessionIdRef.current = undefined;
      setLastFailedInput(undefined);
      setStreaming(true);

      let current = initial;
      let commandFolderUid = command.input.activeFolder?.uid;
      let busyRetries = 0;
      let busyWaitSeconds = 0;
      let terminalError = false;
      let completed = false;
      let failure: Error | undefined;

      const clearStream = () => {
        if (streamControllerRef.current === controller) {
          streamControllerRef.current = undefined;
          assistantMessageIdRef.current = undefined;
          streamSessionIdRef.current = undefined;
          activeTurnIdRef.current = undefined;
          activeClientTurnIdRef.current = undefined;
          setStreaming(false);
        }
      };

      for (;;) {
        try {
          const stream = gateway.streamMessage(command.input, controller.signal);
          for await (const event of stream) {
            if (runID !== streamRunRef.current || routeSessionIdRef.current !== command.input.sessionId) {
              clearStream();
              return;
            }
            current = mergeLatestCanvas(current, openedRef.current);
            if (event.type === 'turn_started') {
              activeTurnIdRef.current = event.payload.turnId;
              continue;
            }
            if (event.type === 'canvas_updated') {
              if (gateway.getCanvas) {
                const latest = await gateway.getCanvas(command.input.sessionId, controller.signal);
                if (routeSessionIdRef.current === command.input.sessionId) {
                  current = { ...current, canvas: latest };
                  publishOpened(current);
                }
              }
              continue;
            }
            const applied = applyAgentEvent(current, event, command.assistantMessageId);
            current = applied.session;
            publishOpened(current);
            if (applied.folderUid) {
              commandFolderUid = applied.folderUid;
              onFolderChange(applied.folderUid);
            }
            if (event.type === 'interrupt') {
              setPendingHITL(event.payload);
              pendingHITLSessionIdRef.current = command.input.sessionId;
              pendingHITLRequestIdRef.current = event.payload.id;
              pendingHITLFolderUidRef.current = commandFolderUid;
              setHitlVisible(true);
            }
            if (event.type === 'error') {
              terminalError = true;
            }
            if (event.type === 'done') {
              completed = true;
            }
          }
          break;
        } catch (error) {
          if (error instanceof ResourceRequestError && error.code === 2006 && busyRetries < maxBusyRetries) {
            const waitSeconds = error.retryAfterSeconds ?? 1;
            if (busyWaitSeconds + waitSeconds <= maxBusyWaitSeconds) {
              busyRetries += 1;
              busyWaitSeconds += waitSeconds;
              try {
                await waitForRetry(waitSeconds * 1000, controller.signal);
                continue;
              } catch (waitError) {
                failure = toError(waitError);
                break;
              }
            }
          }
          failure = toError(error);
          break;
        }
      }

      if (runID !== streamRunRef.current) {
        clearStream();
        return;
      }
      const stopped = stopRequestedRef.current && isAbortError(failure);
      const committed = await reconcileCommand(command, runID);
      if (runID !== streamRunRef.current) {
        clearStream();
        return;
      }
      current = mergeLatestCanvas(current, openedRef.current);
      if (committed) {
        // The persisted aggregate is the terminal source of truth.
      } else if (completed && !terminalError && !failure) {
        current = applyAgentEvent(
          current,
          {
            type: 'error',
            payload: { code: 1007, message: '已提交回复的同步失败，请重试。', retryable: true },
          },
          command.assistantMessageId
        ).session;
        publishOpened(current);
        rememberFailedCommand(command);
      } else if (stopped) {
        current = markMessageStopped(current, command.assistantMessageId);
        publishOpened(current);
      } else if (failure) {
        current = applyAgentEvent(
          current,
          {
            type: 'error',
            payload: { code: errorCode(failure), message: failure.message, retryable: isRetryable(failure) },
          },
          command.assistantMessageId
        ).session;
        publishOpened(current);
        rememberFailedCommand(command);
      } else if (terminalError) {
        rememberFailedCommand(command);
      }

      clearStream();
    },
    [gateway, onFolderChange, publishOpened, reconcileCommand, rememberFailedCommand]
  );

  const sendMessage = useCallback(
    async (input: string, attachments: MessageAttachment[] = []) => {
      const opened = openedRef.current;
      if (
        !opened ||
        !sessionId ||
        opened.session.id !== sessionId ||
        streaming ||
        (pendingHITL && pendingHITLSessionIdRef.current === sessionId) ||
        opened.session.status === 'archived'
      ) {
        return;
      }
      const value = input.trim();
      if (!value) {
        return;
      }

      const clientTurnId = newClientTurnId();
      const userMessage: WorkbenchMessage = {
        id: newMessageId(),
        clientTurnId,
        role: 'user',
        content: value,
        mentions: value.match(/@\w[\w-]*/g) ?? [],
        attachments,
      };
      const assistantMessageId = newMessageId();
      const assistantMessage: WorkbenchMessage = {
        id: assistantMessageId,
        clientTurnId,
        role: 'assistant',
        content: '',
        charts: [],
        streamStatus: 'streaming',
      };
      let current: OpenedSession = {
        ...opened,
        messages: [...opened.messages, userMessage, assistantMessage],
        session: {
          ...opened.session,
          messageCount: opened.messages.length + 2,
          preview: value,
        },
      };
      publishOpened(current);
      await runCommand(
        {
          assistantMessageId,
          previousMessageCount: opened.messages.length,
          input: {
            clientTurnId,
            sessionId: opened.session.id,
            input: value,
            ...(activeFolder ? { activeFolder } : {}),
            mentions: userMessage.mentions ?? [],
          },
        },
        current
      );
    },
    [activeFolder, pendingHITL, publishOpened, runCommand, sessionId, streaming]
  );

  const stopStreaming = useCallback(() => {
    const activeSessionId = streamSessionIdRef.current;
    const turnId = activeTurnIdRef.current;
    const clientTurnId = activeClientTurnIdRef.current;
    const streamController = streamControllerRef.current;
    if (!activeSessionId || !turnId || !clientTurnId || !streamController) {
      return;
    }
    void gateway
      .cancelTurn(activeSessionId, turnId, `cancel-${clientTurnId}`)
      .then(() => {
        if (streamControllerRef.current !== streamController || activeTurnIdRef.current !== turnId) {
          return;
        }
        stopRequestedRef.current = true;
        streamController.abort();
        const opened = openedRef.current;
        if (opened && opened.session.id === routeSessionIdRef.current) {
          publishOpened(markMessageStopped(opened, assistantMessageIdRef.current));
        }
      })
      .catch(() => {
        // 取消未被服务端确认时保留 SSE，避免把断开连接误报为 Turn 已停止。
      });
  }, [gateway, publishOpened]);

  const retryLastMessage = useCallback(async () => {
    const command = failedCommandRef.current;
    const opened = openedRef.current;
    if (
      !command ||
      !opened ||
      !sessionId ||
      failedCommandSessionIdRef.current !== sessionId ||
      streaming ||
      opened.session.id !== command.input.sessionId ||
      opened.session.id !== sessionId
    ) {
      return;
    }
    const reset: OpenedSession = {
      ...opened,
      messages: opened.messages.map((message) =>
        message.id === command.assistantMessageId
          ? { ...message, content: '', charts: [], streamStatus: 'streaming' }
          : message
      ),
    };
    publishOpened(reset);
    await runCommand(command, reset);
  }, [publishOpened, runCommand, sessionId, streaming]);

  const resolveHITL = useCallback(
    async (decision: ResolveInterruptInput['decision'], feedback?: string) => {
      const opened = openedRef.current;
      const request = pendingHITL;
      const requestId = pendingHITLRequestIdRef.current;
      const requestFolderUid = pendingHITLFolderUidRef.current;
      const canApprove = Boolean(
        activeFolder &&
        requestFolderUid &&
        activeFolder.uid === requestFolderUid &&
        (activeFolder.permission === 'Edit' || activeFolder.permission === 'Admin')
      );
      if (
        !opened ||
        opened.session.id !== routeSessionIdRef.current ||
        !request ||
        !requestId ||
        requestId !== request.id ||
        pendingHITLSessionIdRef.current !== opened.session.id ||
        streaming ||
        (decision === 'approved' && !canApprove)
      ) {
        return;
      }
      setHitlVisible(false);
      setPendingHITL(null);
      const runID = ++streamRunRef.current;
      const assistantMessageId = newMessageId();
      let current: OpenedSession = {
        ...opened,
        messages: [
          ...opened.messages,
          { id: assistantMessageId, role: 'assistant', content: '', streamStatus: 'streaming' },
        ],
      };
      publishOpened(current);
      setStreaming(true);
      assistantMessageIdRef.current = assistantMessageId;
      streamControllerRef.current?.abort();
      reconcileControllerRef.current?.abort();
      const controller = new AbortController();
      streamControllerRef.current = controller;
      streamSessionIdRef.current = opened.session.id;
      let restoredPending = false;

      try {
        const stream = gateway.resolveInterrupt(
          {
            sessionId: opened.session.id,
            request,
            decision,
            feedback,
            activeFolder,
          },
          controller.signal
        );
        for await (const event of stream) {
          if (
            runID !== streamRunRef.current ||
            controller.signal.aborted ||
            routeSessionIdRef.current !== opened.session.id
          ) {
            return;
          }
          current = mergeLatestCanvas(current, openedRef.current);
          if (event.type === 'canvas_updated') {
            if (gateway.getCanvas) {
              const latest = await gateway.getCanvas(opened.session.id, controller.signal);
              if (routeSessionIdRef.current === opened.session.id) {
                current = { ...current, canvas: latest };
                publishOpened(current);
              }
            }
            continue;
          }
          current = applyAgentEvent(current, event, assistantMessageId).session;
          publishOpened(current);
          if (event.type === 'interrupt') {
            setPendingHITL(event.payload);
            pendingHITLSessionIdRef.current = opened.session.id;
            pendingHITLRequestIdRef.current = event.payload.id;
            pendingHITLFolderUidRef.current = activeFolder?.uid;
            setHitlVisible(true);
          }
        }
      } catch (error) {
        if (runID === streamRunRef.current && !controller.signal.aborted && !isAbortError(error)) {
          restoredPending = true;
          setPendingHITL(request);
          pendingHITLSessionIdRef.current = opened.session.id;
          pendingHITLRequestIdRef.current = request.id;
          setHitlVisible(true);
          current = mergeLatestCanvas(current, openedRef.current);
          current = applyAgentEvent(
            current,
            { type: 'error', payload: { code: 1007, message: toError(error).message, retryable: true } },
            assistantMessageId
          ).session;
          publishOpened(current);
        }
      } finally {
        if (runID === streamRunRef.current && streamControllerRef.current === controller) {
          setStreaming(false);
          streamControllerRef.current = undefined;
          assistantMessageIdRef.current = undefined;
          streamSessionIdRef.current = undefined;
          if (!restoredPending && pendingHITLRequestIdRef.current === request.id) {
            pendingHITLRequestIdRef.current = undefined;
            pendingHITLSessionIdRef.current = undefined;
            pendingHITLFolderUidRef.current = undefined;
          }
        }
      }
    },
    [activeFolder, gateway, pendingHITL, publishOpened, streaming]
  );

  const updateCanvas = useCallback(
    (update: (canvas: OpenedSession['canvas']) => OpenedSession['canvas']) => {
      const opened = openedRef.current;
      if (!opened || opened.session.id !== routeSessionIdRef.current) {
        return;
      }
      const canvas = update(opened.canvas);
      const next = { ...opened, canvas };
      publishOpened(next);
      if (gateway.updateCanvas) {
        void gateway
          .updateCanvas(opened.session.id, canvas)
          .then((persisted) => {
            const current = openedRef.current;
            if (current?.session.id === opened.session.id && current.canvas === canvas) {
              publishOpened({ ...current, canvas: persisted });
            }
          })
          .catch(() => {
            const current = openedRef.current;
            if (current?.session.id === opened.session.id && current.canvas === canvas) {
              if (gateway.getCanvas) {
                void gateway
                  .getCanvas(opened.session.id)
                  .then((latest) => {
                    const refreshed = openedRef.current;
                    if (refreshed?.session.id === opened.session.id) {
                      publishOpened({ ...refreshed, canvas: latest });
                    }
                  })
                  .catch(() => {
                    const refreshed = openedRef.current;
                    if (refreshed?.session.id === opened.session.id && refreshed.canvas === canvas) {
                      publishOpened({ ...refreshed, canvas: opened.canvas });
                    }
                  });
              } else {
                publishOpened({ ...current, canvas: opened.canvas });
              }
            }
          });
      }
    },
    [gateway, publishOpened]
  );

  const archiveCurrentSession = useCallback(async () => {
    const opened = openedRef.current;
    if (!opened || opened.session.id !== routeSessionIdRef.current || streaming || streamControllerRef.current) {
      return false;
    }
    const routeVersion = routeVersionRef.current;
    const sessionToArchive = opened.session.id;
    setArchiveError(undefined);
    archiveErrorSessionIdRef.current = undefined;
    try {
      const summary = await gateway.archiveSession(sessionToArchive);
      const currentOpened = openedRef.current;
      if (
        routeVersion !== routeVersionRef.current ||
        routeSessionIdRef.current !== sessionToArchive ||
        !currentOpened ||
        currentOpened.session.id !== sessionToArchive
      ) {
        void loadSessions();
        return false;
      }
      publishOpened({ ...currentOpened, session: summary });
      return true;
    } catch (error) {
      if (
        !isAbortError(error) &&
        routeVersion === routeVersionRef.current &&
        routeSessionIdRef.current === sessionToArchive
      ) {
        archiveErrorSessionIdRef.current = sessionToArchive;
        setArchiveError(toError(error).message);
      }
      return false;
    }
  }, [gateway, loadSessions, publishOpened, streaming]);

  const renameCurrentSession = useCallback(
    async (title: string) => {
      const opened = openedRef.current;
      const value = title.trim();
      if (!opened || !value || opened.session.id !== routeSessionIdRef.current || streaming) return false;
      try {
        const summary = await gateway.renameSession(opened.session.id, value);
        if (openedRef.current?.session.id !== summary.id || routeSessionIdRef.current !== summary.id) return false;
        publishOpened({ ...openedRef.current, session: summary });
        await loadSessions();
        return true;
      } catch (error) {
        if (!isAbortError(error)) setArchiveError(toError(error).message);
        return false;
      }
    },
    [gateway, loadSessions, publishOpened, streaming]
  );

  const deleteCurrentSession = useCallback(async () => {
    const opened = openedRef.current;
    if (!opened || opened.session.id !== routeSessionIdRef.current || streaming || deleting.status === 'loading') {
      return false;
    }
    const deletedID = opened.session.id;
    const routeVersion = routeVersionRef.current;
    setDeleting({ status: 'loading' });
    try {
      await gateway.deleteSession(deletedID);
      if (
        routeVersion !== routeVersionRef.current ||
        routeSessionIdRef.current !== deletedID ||
        openedRef.current?.session.id !== deletedID
      ) {
        void loadSessions();
        setDeleting({ status: 'success', data: deletedID });
        return true;
      }
      const currentSessions = sessions.status === 'success' ? sessions.data : [];
      const deletedIndex = currentSessions.findIndex(({ id }) => id === deletedID);
      const remaining = currentSessions.filter(({ id }) => id !== deletedID);
      const nextIndex = deletedIndex < 0 ? 0 : Math.min(deletedIndex, Math.max(0, remaining.length - 1));
      const nextSession = remaining[nextIndex];

      // 使尚未返回的详情请求失效，避免已删除会话重新写回页面。
      invalidateSessions();
      openRequestRef.current += 1;
      setOpenedSession({ status: 'idle' });
      setSessions({ status: 'success', data: remaining });
      setDeleting({ status: 'success', data: deletedID });
      onNavigate(nextSession?.id, true);
      return true;
    } catch (error) {
      if (!isAbortError(error)) {
        setDeleting({ status: 'error', error: toError(error) });
      }
      return false;
    }
  }, [deleting.status, gateway, invalidateSessions, loadSessions, onNavigate, sessions, setOpenedSession, streaming]);

  const visibleOpenedSession: AsyncState<OpenedSession> = !sessionId
    ? { status: 'idle' }
    : openedSessionIdRef.current === sessionId
      ? openedSession
      : { status: 'loading' };
  const visibleContext: AsyncState<WorkbenchContext> = !activeFolderUid
    ? { status: 'idle' }
    : contextFolderUidRef.current !== activeFolderUid
      ? { status: 'loading' }
      : context;
  const visiblePendingHITL = sessionId && pendingHITLSessionIdRef.current === sessionId ? pendingHITL : null;
  const visiblePendingHITLFolderUid = visiblePendingHITL ? pendingHITLFolderUidRef.current : undefined;
  const visibleLastFailedInput =
    sessionId && failedCommandSessionIdRef.current === sessionId ? lastFailedInput : undefined;
  const visibleArchiveError = sessionId && archiveErrorSessionIdRef.current === sessionId ? archiveError : undefined;
  const visibleStreaming = Boolean(sessionId && streaming && streamSessionIdRef.current === sessionId);
  const visibleHITL = Boolean(visiblePendingHITL && hitlVisible);

  return {
    sessions,
    openedSession: visibleOpenedSession,
    context: visibleContext,
    creating,
    deleting,
    archiveError: visibleArchiveError,
    streaming: visibleStreaming,
    pendingHITL: visiblePendingHITL,
    pendingHITLFolderUid: visiblePendingHITLFolderUid,
    hitlVisible: visibleHITL,
    lastFailedInput: visibleLastFailedInput,
    createSession,
    resetCreate: () => setCreating({ status: 'idle' }),
    resetDelete: () => setDeleting({ status: 'idle' }),
    retrySessions: loadSessions,
    retryOpenedSession: () => {
      if (sessionId) {
        void loadOpenedSession(sessionId);
      }
    },
    retryContext: () => {
      const folderUid = activeFolder?.uid;
      if (folderUid && activeFolderUidRef.current === folderUid) {
        void loadContext(folderUid);
      }
    },
    sendMessage,
    retryLastMessage,
    stopStreaming,
    resolveHITL,
    hideHITL: () => setHitlVisible(false),
    showHITL: () => {
      if (visiblePendingHITL) {
        setHitlVisible(true);
      }
    },
    updateCanvas,
    archiveCurrentSession,
    renameCurrentSession,
    resetArchiveError: () => {
      archiveErrorSessionIdRef.current = undefined;
      setArchiveError(undefined);
    },
    deleteCurrentSession,
  };
}

function newMessageId(): string {
  messageCounter += 1;
  return `message-${Date.now()}-${messageCounter}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error('发生未知错误。');
}

function errorCode(error: Error): number {
  return error instanceof ResourceRequestError ? error.code : 1007;
}

function isRetryable(error: Error): boolean {
  return error instanceof ResourceRequestError && (error.code === 1007 || error.code === 1008 || error.code === 2006);
}

function waitForRetry(durationMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  if (durationMs <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, durationMs);
    const onAbort = () => {
      window.clearTimeout(timeout);
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function mergeLatestCanvas(current: OpenedSession, latest?: OpenedSession): OpenedSession {
  if (!latest || latest.session.id !== current.session.id || latest.canvas === current.canvas) {
    return current;
  }
  return { ...current, canvas: latest.canvas };
}
