import {
  CreatePlaybookInput,
  PlaybookDocument,
  PlaybookSummary,
  PlaybookValidationResult,
  UpdatePlaybookInput,
} from '../crudModel';

export interface PlaybookCrudGateway {
  listPlaybooks(signal?: AbortSignal): Promise<PlaybookSummary[]>;
  getPlaybook(id: string, signal?: AbortSignal): Promise<PlaybookDocument>;
  createPlaybook(input: CreatePlaybookInput, signal?: AbortSignal): Promise<PlaybookDocument>;
  updatePlaybook(id: string, input: UpdatePlaybookInput, signal?: AbortSignal): Promise<PlaybookDocument>;
  deletePlaybook(id: string, signal?: AbortSignal): Promise<void>;
  validatePlaybook(source: string, signal?: AbortSignal): Promise<PlaybookValidationResult>;
}
