import { FolderPermission } from '../../app/model';

export type KnowledgeTab = 'services' | 'runbooks' | 'documents' | 'imports';
export type ServiceTier = 'critical' | 'standard' | 'low';
export type RunbookSeverity = 'info' | 'warning' | 'critical';
export type RunbookSource = 'manual' | 'imported';
export type ImportTaskStatus = 'parsing' | 'reviewing' | 'done' | 'failed' | 'cancelled';

export interface KeyMetric {
  name: string;
  expr: string;
  threshold: string;
}

export interface ServiceEntry {
  id: string;
  folderUid: string;
  name: string;
  displayName: string;
  owner: string;
  tier: ServiceTier;
  keyMetrics: KeyMetric[];
  runbookCount: number;
  playbookCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface RunbookVersion {
  version: number;
  author: string;
  savedAt: string;
  title: string;
  body: string;
}

export interface Runbook {
  id: string;
  folderUid: string;
  title: string;
  serviceId?: string;
  tags: string[];
  severity: RunbookSeverity;
  author: string;
  source: RunbookSource;
  excerpt: string;
  body: string;
  version: number;
  history: RunbookVersion[];
  createdAt: string;
  updatedAt: string;
}

export type DocumentFormat = 'md' | 'pdf' | 'docx' | 'html' | 'txt' | 'confluence';

export interface KnowledgeDocument {
  id: string;
  folderUid: string;
  name: string;
  format: DocumentFormat;
  sizeBytes: number;
  chunks: number;
  tags: string[];
  serviceId?: string;
  importedBy: string;
  preview: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ImportFileDescriptor {
  id: string;
  name: string;
  format: DocumentFormat;
  sizeBytes: number;
  preview: string;
}

export interface ImportCandidate extends ImportFileDescriptor {
  tags: string[];
  serviceId?: string;
  author: string;
  error?: string;
}

export interface ImportTask {
  id: string;
  folderUid: string;
  status: ImportTaskStatus;
  progress: number;
  files: number;
  failed: number;
  importedBy: string;
  candidates: ImportCandidate[];
  createdDocumentIds: string[];
  startedAt: string;
  updatedAt: string;
}

export interface KnowledgeCounts {
  services: number;
  runbooks: number;
  documents: number;
  imports: number;
}

export interface KnowledgeSnapshot {
  folderUid: string;
  services: ServiceEntry[];
  runbooks: Runbook[];
  documents: KnowledgeDocument[];
  imports: ImportTask[];
  counts: KnowledgeCounts;
}

export interface KnowledgeData {
  schemaVersion: 1;
  services: ServiceEntry[];
  runbooks: Runbook[];
  documents: KnowledgeDocument[];
  imports: ImportTask[];
}

export interface CreateServiceInput {
  folderUid: string;
  name: string;
  displayName: string;
  owner: string;
  tier: ServiceTier;
  keyMetrics: KeyMetric[];
}

export type UpdateServiceInput = Omit<CreateServiceInput, 'folderUid'>;

export interface CreateRunbookInput {
  folderUid: string;
  title: string;
  serviceId?: string;
  tags: string[];
  severity: RunbookSeverity;
  author: string;
  source: RunbookSource;
  excerpt: string;
  body: string;
}

export type UpdateRunbookInput = Omit<CreateRunbookInput, 'folderUid'>;

export interface UpdateDocumentInput {
  name: string;
  tags: string[];
  serviceId?: string;
  importedBy: string;
}

export interface StartImportInput {
  folderUid: string;
  importedBy: string;
  files: ImportFileDescriptor[];
}

export interface ConfirmImportInput {
  taskId: string;
  skipFailures: boolean;
  candidates: ImportCandidate[];
}

export interface ImportResult {
  task: ImportTask;
  documents: KnowledgeDocument[];
}

export type ImportTaskEvent =
  | { type: 'task_updated'; payload: ImportTask }
  | { type: 'task_failed'; payload: { task: ImportTask; message: string } };

export type FolderPermissionMap = Record<string, FolderPermission>;
