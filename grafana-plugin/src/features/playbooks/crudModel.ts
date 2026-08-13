export type PlaybookStatus = 'active' | 'disabled';

export interface PlaybookSummary {
  id: string;
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
