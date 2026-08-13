import {
  CreatePlaybookInput,
  GeneratePlaybookDraftInput,
  Playbook,
  PlaybookDraft,
  PlaybookListInput,
  PlaybookRun,
  PlaybookRunEvent,
  ResolvePlaybookRunInput,
  StartPlaybookRunInput,
  UpdatePlaybookInput,
} from '../model';

export interface PlaybookGateway {
  listPlaybooks(input: PlaybookListInput, signal?: AbortSignal): Promise<Playbook[]>;
  getPlaybook(id: string, signal?: AbortSignal): Promise<Playbook>;
  createPlaybook(input: CreatePlaybookInput, signal?: AbortSignal): Promise<Playbook>;
  updatePlaybook(
    id: string,
    input: UpdatePlaybookInput,
    expectedVersion: number,
    signal?: AbortSignal
  ): Promise<Playbook>;
  deletePlaybook(id: string, expectedVersion: number, signal?: AbortSignal): Promise<void>;
  generateDraft(input: GeneratePlaybookDraftInput, signal?: AbortSignal): Promise<PlaybookDraft>;
  getDraft(id: string, signal?: AbortSignal): Promise<PlaybookDraft>;
  discardDraft(id: string, signal?: AbortSignal): Promise<void>;
  listRuns(playbookId: string, signal?: AbortSignal): Promise<PlaybookRun[]>;
  startDryRun(input: StartPlaybookRunInput, signal: AbortSignal): AsyncIterable<PlaybookRunEvent>;
  resolveRun(input: ResolvePlaybookRunInput, signal: AbortSignal): AsyncIterable<PlaybookRunEvent>;
  cancelRun(runId: string, signal?: AbortSignal): Promise<PlaybookRun>;
  retryRun(runId: string, signal: AbortSignal): AsyncIterable<PlaybookRunEvent>;
}
