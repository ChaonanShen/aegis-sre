export type SkillVisibility = 'private' | 'shared';
export type SkillParameterType = 'string' | 'number' | 'bool';

export interface SkillParameter {
  name: string;
  type: SkillParameterType;
  description: string;
  defaultValue: string;
  required: boolean;
}

export interface SkillDefinition {
  name: string;
  description: string;
  slashCommand: string;
  allowedTools: string[];
  timeout: string;
  parameters: SkillParameter[];
  tags: string[];
  body: string;
  visibility: SkillVisibility;
  folderUid?: string;
}

export interface SkillRevision {
  revision: number;
  author: string;
  savedAt: string;
  changeNote: string;
  snapshot: SkillDefinition;
}

export interface Skill extends SkillDefinition {
  id: string;
  ownerId: string;
  usageCount: number;
  recordVersion: number;
  latestChangeNote: string;
  revisions: SkillRevision[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateSkillInput extends SkillDefinition {
  changeNote: string;
}

export interface UpdateSkillInput extends SkillDefinition {
  changeNote: string;
}

export interface SkillListInput {
  folderUids: string[];
}

export type SkillRunStatus = 'running' | 'waiting_for_approval' | 'success' | 'failed' | 'cancelled';
export type SkillToolCallStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

export interface SkillToolCall {
  id: string;
  tool: string;
  status: SkillToolCallStatus;
  input: Record<string, string>;
  output?: string;
}

export interface SkillRunInterrupt {
  callId: string;
  tool: string;
  preview: string[];
}

export interface SkillRun {
  id: string;
  skillId: string;
  status: SkillRunStatus;
  dryRun: true;
  params: Record<string, string>;
  toolCalls: SkillToolCall[];
  pendingInterrupt?: SkillRunInterrupt;
  resultMarkdown?: string;
  initiatedBy: string;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
}

export interface StartSkillRunInput {
  skillId: string;
  params: Record<string, string>;
}

export interface ResolveSkillRunInput {
  runId: string;
  decision: 'approved' | 'skipped';
}

export type SkillRunEvent = { type: 'run_updated'; payload: SkillRun };

export interface SkillsRuntimeInfo {
  status: 'running' | 'stopped';
  listenAddress: string;
  clientUrl: string;
  tools: Array<{ name: string; access: 'read' | 'write'; hitl: boolean }>;
}

export interface SkillData {
  schemaVersion: 1;
  skills: Skill[];
  runs: SkillRun[];
}
