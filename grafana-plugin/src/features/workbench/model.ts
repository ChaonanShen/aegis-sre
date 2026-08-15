import { Folder } from '../../app/model';

export type SessionStatus = 'active' | 'archived';
export type SessionVisibility = 'private' | 'team';
export type ToolStatus = 'pending' | 'ok' | 'err';
export type ToolTier = 'read' | 'write' | 'execute';
export type ChartType = 'line' | 'bar' | 'stat' | 'gauge';

export interface SessionSummary {
  id: string;
  title: string;
  folderUid: string;
  folderTitle: string;
  status: SessionStatus;
  visibility: SessionVisibility;
  forkedFrom?: string;
  updatedAt: string;
  messageCount: number;
  preview: string;
}

export interface MessageAttachment {
  id: string;
  name: string;
  size: number;
  type: string;
}

export interface SavedChartPreview {
  id: string;
  title: string;
  description: string;
  visualization: ChartType;
  /** fixture 只允许显式开发/测试模式；definition 必须查询真实 Grafana 数据源。 */
  renderMode?: 'fixture' | 'definition';
  /** 持久化的 Dashboard v2 VizConfig，不包含查询、布局或查询结果。 */
  vizConfig?: unknown;
  /** 持久化 Query；range 是不会随刷新漂移的绝对时间范围。 */
  query?: SavedQuery;
}

export interface SavedQuery {
  id: string;
  session_id: string;
  version: number;
  spec: {
    datasource_uid: string;
    expression: string;
    range: { from: string; to: string; step_seconds: number };
  };
  created_at: string;
}

export interface ToolCall {
  id: string;
  server: string;
  tool: string;
  tier: ToolTier;
  args?: string;
  result?: string;
  status: ToolStatus;
  durationMs?: number;
}

export interface WorkbenchMessage {
  id: string;
  clientTurnId?: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  mentions?: string[];
  attachments?: MessageAttachment[];
  charts?: SavedChartPreview[];
  toolCalls?: ToolCall[];
  streamStatus?: 'streaming' | 'complete' | 'stopped' | 'error';
}

export interface CanvasPreview {
  visible: boolean;
  layout: CanvasLayout;
  charts: SavedChartPreview[];
  revision?: number;
  activeChartId?: string;
}

/** Layout values registered by the public Canvas contract. */
export type CanvasLayout = 'grid-2x2' | 'grid-3x2' | 'flex';

export interface OpenedSession {
  session: SessionSummary;
  messages: WorkbenchMessage[];
  canvas: CanvasPreview;
}

export interface WorkbenchContext {
  activeFolder: Folder;
  sharedFolder: Folder;
  injectedServices: Array<{
    name: string;
    folderUid: string;
    tier: 'critical' | 'standard';
  }>;
  skills: Array<{ name: string; description: string }>;
  recent: Array<{ type: 'playbook' | 'runbook'; name: string }>;
  cost: {
    llmCalls: number;
    toolRounds: number;
    maxToolRounds: number;
    tokensIn: string;
    tokensOut: string;
    latency: string;
  };
}

export interface CreateSessionInput {
  title: string;
  /** Folder 尚未接入真实 gateway 时允许不绑定。 */
  folder?: Folder;
}

export interface SendMessageInput {
  clientTurnId: string;
  sessionId: string;
  input: string;
  /** 真实链路当前允许没有 Folder 上下文。 */
  activeFolder?: Folder;
  mentions: string[];
}

export class ResourceRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: number,
    message: string,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = 'ResourceRequestError';
  }
}

export interface PendingHITL {
  id: string;
  clientTurnId: string;
  toolCallId: string;
  server: string;
  tool: string;
  args: string;
  preview: string[];
  reason: string;
}

export interface ResolveInterruptInput {
  sessionId: string;
  request: PendingHITL;
  decision: 'approved' | 'rejected';
  feedback?: string;
  /** Required for approval; rejection can safely clear a pending request without it. */
  activeFolder?: Folder;
}

export type AgentEvent =
  | { type: 'message_start' }
  | { type: 'turn_started'; payload: { turnId: string } }
  | { type: 'message_delta'; payload: { delta: string } }
  | { type: 'message_end'; payload: { charts?: SavedChartPreview[] } }
  | { type: 'chart'; payload: SavedChartPreview }
  | { type: 'tool_call'; payload: ToolCall }
  | {
      type: 'tool_result';
      payload: { id: string; result: string; status: Exclude<ToolStatus, 'pending'>; durationMs: number };
    }
  | { type: 'interrupt'; payload: PendingHITL }
  | { type: 'folder_changed'; payload: { folderUid: string } }
  | { type: 'canvas_updated'; payload: { sessionId: string; chartId: string; operationId: string; revision: number } }
  | { type: 'done'; payload: { turnId: string; replayed: boolean } }
  | { type: 'error'; payload: { code: number; message: string; retryable: boolean } };
