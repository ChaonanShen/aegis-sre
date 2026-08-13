import {
  ConfirmImportInput,
  CreateRunbookInput,
  CreateServiceInput,
  ImportResult,
  ImportTask,
  ImportTaskEvent,
  KnowledgeDocument,
  KnowledgeSnapshot,
  Runbook,
  ServiceEntry,
  StartImportInput,
  UpdateDocumentInput,
  UpdateRunbookInput,
  UpdateServiceInput,
} from '../model';

export interface KnowledgeGateway {
  getSnapshot(folderUid: string, signal?: AbortSignal): Promise<KnowledgeSnapshot>;
  createService(input: CreateServiceInput, signal?: AbortSignal): Promise<ServiceEntry>;
  updateService(
    id: string,
    input: UpdateServiceInput,
    expectedVersion: number,
    signal?: AbortSignal
  ): Promise<ServiceEntry>;
  deleteService(id: string, expectedVersion: number, signal?: AbortSignal): Promise<void>;
  createRunbook(input: CreateRunbookInput, signal?: AbortSignal): Promise<Runbook>;
  updateRunbook(
    id: string,
    input: UpdateRunbookInput,
    expectedVersion: number,
    signal?: AbortSignal
  ): Promise<Runbook>;
  deleteRunbook(id: string, expectedVersion: number, signal?: AbortSignal): Promise<void>;
  updateDocument(
    id: string,
    input: UpdateDocumentInput,
    expectedVersion: number,
    signal?: AbortSignal
  ): Promise<KnowledgeDocument>;
  deleteDocument(id: string, expectedVersion: number, signal?: AbortSignal): Promise<void>;
  startImport(input: StartImportInput, signal: AbortSignal): AsyncIterable<ImportTaskEvent>;
  confirmImport(input: ConfirmImportInput, signal?: AbortSignal): Promise<ImportResult>;
  retryImport(taskId: string, signal: AbortSignal): AsyncIterable<ImportTaskEvent>;
  cancelImport(taskId: string, signal?: AbortSignal): Promise<ImportTask>;
  deleteImportTask(taskId: string, signal?: AbortSignal): Promise<void>;
}
