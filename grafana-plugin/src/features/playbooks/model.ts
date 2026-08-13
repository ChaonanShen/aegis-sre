export type PlaybookVisibility = 'private' | 'shared';
export type PlaybookStepType = 'query' | 'branch' | 'loop' | 'template' | 'mcp_call' | 'parallel';
export type PlaybookParamType = 'string' | 'number' | 'bool';
export type PlaybookTriggerType = 'manual' | 'alert';

export interface PlaybookTrigger {
  type: PlaybookTriggerType;
  pattern?: string;
  alertLabels: Record<string, string>;
}

export interface PlaybookParameter {
  name: string;
  type: PlaybookParamType;
  defaultValue: string;
  required: boolean;
}

export interface PlaybookExpect {
  expression: string;
  onFail: 'continue' | 'fail';
}

export interface PlaybookStep {
  id: string;
  type: PlaybookStepType;
  label: string;
  dependsOn: string[];
  config: Record<string, unknown>;
  expect?: PlaybookExpect;
  sideEffect: boolean;
  dryRun: boolean;
}

export interface PlaybookExperienceNote {
  author: string;
  date: string;
  body: string;
}

export interface PlaybookDefinition {
  /** 原生 Dagu YAML；真实模式下它是唯一可写事实来源。 */
  source?: string;
  name: string;
  description: string;
  version: string;
  trigger: PlaybookTrigger;
  parameters: PlaybookParameter[];
  steps: PlaybookStep[];
  experience: PlaybookExperienceNote[];
  visibility: PlaybookVisibility;
  folderUid?: string;
}

export interface PlaybookRevision {
  revision: number;
  displayVersion: string;
  author: string;
  savedAt: string;
  changeNote: string;
  snapshot: PlaybookDefinition;
}

export interface Playbook extends PlaybookDefinition {
  id: string;
  ownerId: string;
  usageCount: number;
  recordVersion: number;
  latestChangeNote: string;
  revisions: PlaybookRevision[];
  createdAt: string;
  updatedAt: string;
}

export interface PlaybookDraft extends PlaybookDefinition {
  id: string;
  sourceSessionId: string;
  sourceSessionTitle: string;
  ownerId: string;
  changeNote: string;
  createdAt: string;
}

export interface CreatePlaybookInput extends PlaybookDefinition {
  changeNote: string;
}

export interface UpdatePlaybookInput extends PlaybookDefinition {
  changeNote: string;
}

export interface PlaybookListInput {
  folderUids: string[];
}

export interface GeneratePlaybookDraftInput {
  sessionId: string;
  sessionTitle: string;
  folderUid: string;
}

export type PlaybookRunStatus =
  | 'running'
  | 'waiting_for_approval'
  | 'success'
  | 'failed'
  | 'cancelled';
export type PlaybookStepRunStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

export interface PlaybookStepRun {
  stepId: string;
  label: string;
  type: PlaybookStepType;
  status: PlaybookStepRunStatus;
  output?: string;
  error?: string;
  durationMs?: number;
}

export interface PlaybookRunInterrupt {
  stepId: string;
  server: string;
  tool: string;
  preview: string[];
}

export interface PlaybookRun {
  id: string;
  playbookId: string;
  status: PlaybookRunStatus;
  dryRun: true;
  params: Record<string, string>;
  steps: PlaybookStepRun[];
  pendingInterrupt?: PlaybookRunInterrupt;
  initiatedBy: string;
  retryOf?: string;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
}

export interface StartPlaybookRunInput {
  playbookId: string;
  params: Record<string, string>;
  retryOf?: string;
}

export interface ResolvePlaybookRunInput {
  runId: string;
  decision: 'approved' | 'skipped';
}

export type PlaybookRunEvent =
  | { type: 'run_updated'; payload: PlaybookRun }
  | { type: 'run_failed'; payload: { run: PlaybookRun; message: string } };

export interface PlaybookData {
  schemaVersion: 1;
  playbooks: Playbook[];
  drafts: PlaybookDraft[];
  runs: PlaybookRun[];
}
