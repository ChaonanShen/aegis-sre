import {
  AgentEvent,
  CreateSessionInput,
  OpenedSession,
  ResolveInterruptInput,
  SendMessageInput,
  SessionSummary,
  WorkbenchContext,
} from '../model';

export interface WorkbenchGateway {
  listSessions(signal?: AbortSignal): Promise<SessionSummary[]>;
  openSession(sessionId: string, signal?: AbortSignal): Promise<OpenedSession>;
  createSession(input: CreateSessionInput, signal?: AbortSignal): Promise<OpenedSession>;
  renameSession(sessionId: string, title: string, signal?: AbortSignal): Promise<SessionSummary>;
  archiveSession(sessionId: string, signal?: AbortSignal): Promise<SessionSummary>;
  deleteSession(sessionId: string, signal?: AbortSignal): Promise<void>;
  updateCanvas?(
    sessionId: string,
    canvas: OpenedSession['canvas'],
    signal?: AbortSignal
  ): Promise<OpenedSession['canvas']>;
  getCanvas?(sessionId: string, signal?: AbortSignal): Promise<OpenedSession['canvas']>;
  getContext(folderUid: string, signal?: AbortSignal): Promise<WorkbenchContext>;
  streamMessage(input: SendMessageInput, signal: AbortSignal): AsyncIterable<AgentEvent>;
  cancelTurn(sessionId: string, turnId: string, idempotencyKey: string, signal?: AbortSignal): Promise<void>;
  resolveInterrupt(input: ResolveInterruptInput, signal: AbortSignal): AsyncIterable<AgentEvent>;
}
