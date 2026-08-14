import {
  AgentEvent,
  CanvasPreview,
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
  archiveSession(sessionId: string, signal?: AbortSignal): Promise<SessionSummary>;
  deleteSession(sessionId: string, signal?: AbortSignal): Promise<void>;
  getContext(folderUid: string, signal?: AbortSignal): Promise<WorkbenchContext>;
  streamMessage(input: SendMessageInput, signal: AbortSignal): AsyncIterable<AgentEvent>;
  cancelTurn(sessionId: string, turnId: string, idempotencyKey: string, signal?: AbortSignal): Promise<void>;
  resolveInterrupt(input: ResolveInterruptInput, signal: AbortSignal): AsyncIterable<AgentEvent>;
}
