import {
  CreatePlaybookInput,
  PlaybookDocument,
  PlaybookRunRecord,
  PlaybookArtifact,
  PlaybookArtifactPreview,
  PlaybookApprovalDecision,
  PlaybookSummary,
  PlaybookValidationResult,
  StartPlaybookRunInput,
  UpdatePlaybookInput,
} from '../crudModel';

export interface PlaybookCrudGateway {
  listPlaybooks(signal?: AbortSignal): Promise<PlaybookSummary[]>;
  getPlaybook(id: string, signal?: AbortSignal): Promise<PlaybookDocument>;
  createPlaybook(input: CreatePlaybookInput, signal?: AbortSignal): Promise<PlaybookDocument>;
  updatePlaybook(id: string, input: UpdatePlaybookInput, signal?: AbortSignal): Promise<PlaybookDocument>;
  deletePlaybook(id: string, signal?: AbortSignal): Promise<void>;
  validatePlaybook(source: string, signal?: AbortSignal): Promise<PlaybookValidationResult>;
  listRuns(playbookId: string, signal?: AbortSignal): Promise<PlaybookRunRecord[]>;
  startRun(playbookId: string, input: StartPlaybookRunInput, signal?: AbortSignal): Promise<PlaybookRunRecord>;
  getRun(runId: string, signal?: AbortSignal): Promise<PlaybookRunRecord>;
  cancelRun(runId: string, signal?: AbortSignal): Promise<void>;
  retryRun(runId: string, idempotencyKey: string, signal?: AbortSignal): Promise<PlaybookRunRecord>;
  streamRun(runId: string, afterSequence: number, signal?: AbortSignal): AsyncIterable<PlaybookRunRecord>;
  completeHumanTask(runId: string, stepId: string, input: Record<string, unknown>, idempotencyKey: string, signal?: AbortSignal): Promise<void>;
  resolveApproval(runId: string, stepId: string, decision: PlaybookApprovalDecision, inputs: Record<string, string>, idempotencyKey: string, signal?: AbortSignal): Promise<void>;
  listArtifacts(runId: string, signal?: AbortSignal): Promise<PlaybookArtifact[]>;
  previewArtifact(runId: string, path: string, signal?: AbortSignal): Promise<PlaybookArtifactPreview>;
  artifactDownloadUrl(runId: string, path: string): string;
}
