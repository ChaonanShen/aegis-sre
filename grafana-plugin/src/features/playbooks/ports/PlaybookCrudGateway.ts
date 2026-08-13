import {
  CreatePlaybookInput,
  PlaybookDocument,
  PlaybookRunRecord,
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
}
