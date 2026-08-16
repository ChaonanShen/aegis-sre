export type PlaybookStatus = 'active' | 'disabled';

export interface PlaybookSummary {
  id: string;
  folderUid: string;
  name: string;
  description: string;
  status: PlaybookStatus;
}

export interface PlaybookDocument extends PlaybookSummary {
  /** 原生 Dagu YAML，是 Playbook 唯一可写事实来源。 */
  source: string;
}

export interface CreatePlaybookInput {
  source: string;
  /** 同一次用户保存操作和网络重试必须复用同一个键。 */
  idempotencyKey: string;
}

export interface UpdatePlaybookInput {
  source: string;
}

export interface PlaybookValidationIssue {
  path?: string;
  message: string;
}

export interface PlaybookValidationResult {
  valid: boolean;
  errors: PlaybookValidationIssue[];
}

export type PlaybookRunStatus =
  | 'queued'
  | 'running'
  | 'waiting_for_input'
  | 'waiting_for_approval'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface PlaybookRunStep {
  id: string;
  name: string;
  status: PlaybookRunStatus;
  startedAt?: string;
  endedAt?: string;
  humanTask?: Record<string, unknown>;
  approval?: Record<string, unknown>;
}

export interface PlaybookRunRecord {
  id: string;
  playbookId: string;
  status: PlaybookRunStatus;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  steps: PlaybookRunStep[];
}

export interface StartPlaybookRunInput {
  parameters?: Record<string, string>;
  /** 同一次用户执行操作和网络重试必须复用同一个键。 */
  idempotencyKey: string;
}

export interface PlaybookArtifact {
  name: string;
  path: string;
  mediaType: string;
  size: number;
}

export interface PlaybookArtifactPreview extends PlaybookArtifact {
  text: string;
  truncated: boolean;
}

export type PlaybookApprovalDecision = 'approve' | 'reject' | 'rewind';
