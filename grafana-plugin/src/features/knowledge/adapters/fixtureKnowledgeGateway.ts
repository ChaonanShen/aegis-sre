import {
  KnowledgeNotFoundError,
  KnowledgePermissionError,
  KnowledgeValidationError,
  KnowledgeVersionConflictError,
} from '../errors';
import { knowledgeFixtureData, knowledgeFixturePermissions } from '../fixtures/knowledgeFixtures';
import {
  CreateRunbookInput,
  CreateServiceInput,
  FolderPermissionMap,
  ImportCandidate,
  ImportFileDescriptor,
  ImportResult,
  ImportTask,
  ImportTaskEvent,
  KnowledgeData,
  KnowledgeDocument,
  KnowledgeSnapshot,
  Runbook,
  ServiceEntry,
  StartImportInput,
  UpdateDocumentInput,
  UpdateRunbookInput,
  UpdateServiceInput,
} from '../model';
import { KnowledgeGateway } from '../ports/KnowledgeGateway';

const DEFAULT_STORAGE_KEY = 'torchbearing.fixture.knowledge.v1';

export interface FixtureKnowledgeGatewayOptions {
  storage?: Pick<Storage, 'getItem' | 'setItem'>;
  storageKey?: string;
  latencyMs?: number;
  importDelayMs?: number;
  now?: () => Date;
  newId?: (prefix: string) => string;
  permissions?: FolderPermissionMap;
}

export function createFixtureKnowledgeGateway(options: FixtureKnowledgeGatewayOptions = {}): KnowledgeGateway {
  const storage = options.storage ?? window.sessionStorage;
  const storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;
  const latencyMs = options.latencyMs ?? 80;
  const importDelayMs = options.importDelayMs ?? 250;
  const now = options.now ?? (() => new Date());
  const newId =
    options.newId ?? ((prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  const permissions = options.permissions ?? knowledgeFixturePermissions;

  const read = () => readData(storage, storageKey);
  const write = (data: KnowledgeData) => storage.setItem(storageKey, JSON.stringify(data));
  const assertWritable = (folderUid: string) => {
    if (permissions[folderUid] === 'View' || !permissions[folderUid]) {
      throw new KnowledgePermissionError(folderUid);
    }
  };

  return {
    async getSnapshot(folderUid, signal) {
      await delay(latencyMs, signal);
      return snapshot(read(), folderUid);
    },

    async createService(input, signal) {
      await delay(latencyMs, signal);
      assertWritable(input.folderUid);
      validateService(input);
      const data = read();
      if (data.services.some(({ folderUid, name }) => folderUid === input.folderUid && name === input.name.trim())) {
        throw new KnowledgeValidationError(`当前 Folder 已存在 Service "@${input.name.trim()}"。`);
      }
      const timestamp = now().toISOString();
      const created: ServiceEntry = {
        ...clone(input),
        id: newId('svc'),
        name: input.name.trim(),
        displayName: input.displayName.trim(),
        owner: input.owner.trim(),
        runbookCount: 0,
        playbookCount: 0,
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      data.services.unshift(created);
      write(data);
      return clone(created);
    },

    async updateService(id, input, expectedVersion, signal) {
      await delay(latencyMs, signal);
      validateService(input);
      const data = read();
      const index = data.services.findIndex((service) => service.id === id);
      const current = data.services[index];
      if (!current) {
        throw new KnowledgeNotFoundError('Service', id);
      }
      assertWritable(current.folderUid);
      assertVersion('Service', current, expectedVersion);
      if (
        data.services.some(
          ({ id: otherId, folderUid, name }) =>
            otherId !== id && folderUid === current.folderUid && name === input.name.trim()
        )
      ) {
        throw new KnowledgeValidationError(`当前 Folder 已存在 Service "@${input.name.trim()}"。`);
      }
      const updated: ServiceEntry = {
        ...current,
        ...clone(input),
        name: input.name.trim(),
        displayName: input.displayName.trim(),
        owner: input.owner.trim(),
        version: current.version + 1,
        updatedAt: now().toISOString(),
      };
      data.services[index] = updated;
      write(data);
      return clone(updated);
    },

    async deleteService(id, expectedVersion, signal) {
      await delay(latencyMs, signal);
      const data = read();
      const current = data.services.find((service) => service.id === id);
      if (!current) {
        throw new KnowledgeNotFoundError('Service', id);
      }
      assertWritable(current.folderUid);
      assertVersion('Service', current, expectedVersion);
      data.services = data.services.filter((service) => service.id !== id);
      data.runbooks = data.runbooks.map((runbook) =>
        runbook.serviceId === id ? { ...runbook, serviceId: undefined } : runbook
      );
      data.documents = data.documents.map((document) =>
        document.serviceId === id ? { ...document, serviceId: undefined } : document
      );
      write(data);
    },

    async createRunbook(input, signal) {
      await delay(latencyMs, signal);
      assertWritable(input.folderUid);
      validateRunbook(input);
      const data = read();
      const timestamp = now().toISOString();
      const created: Runbook = {
        ...clone(input),
        id: newId('rb'),
        title: input.title.trim(),
        excerpt: input.excerpt.trim(),
        body: input.body.trim(),
        version: 1,
        history: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      data.runbooks.unshift(created);
      syncRunbookCounts(data);
      write(data);
      return clone(created);
    },

    async updateRunbook(id, input, expectedVersion, signal) {
      await delay(latencyMs, signal);
      validateRunbook(input);
      const data = read();
      const index = data.runbooks.findIndex((runbook) => runbook.id === id);
      const current = data.runbooks[index];
      if (!current) {
        throw new KnowledgeNotFoundError('Runbook', id);
      }
      assertWritable(current.folderUid);
      assertVersion('Runbook', current, expectedVersion);
      const timestamp = now().toISOString();
      const updated: Runbook = {
        ...current,
        ...clone(input),
        title: input.title.trim(),
        excerpt: input.excerpt.trim(),
        body: input.body.trim(),
        version: current.version + 1,
        history: [
          {
            version: current.version,
            author: current.author,
            savedAt: timestamp,
            title: current.title,
            body: current.body,
          },
          ...current.history,
        ],
        updatedAt: timestamp,
      };
      data.runbooks[index] = updated;
      syncRunbookCounts(data);
      write(data);
      return clone(updated);
    },

    async deleteRunbook(id, expectedVersion, signal) {
      await delay(latencyMs, signal);
      const data = read();
      const current = data.runbooks.find((runbook) => runbook.id === id);
      if (!current) {
        throw new KnowledgeNotFoundError('Runbook', id);
      }
      assertWritable(current.folderUid);
      assertVersion('Runbook', current, expectedVersion);
      data.runbooks = data.runbooks.filter((runbook) => runbook.id !== id);
      syncRunbookCounts(data);
      write(data);
    },

    async updateDocument(id, input, expectedVersion, signal) {
      await delay(latencyMs, signal);
      validateDocument(input);
      const data = read();
      const index = data.documents.findIndex((document) => document.id === id);
      const current = data.documents[index];
      if (!current) {
        throw new KnowledgeNotFoundError('Document', id);
      }
      assertWritable(current.folderUid);
      assertVersion('Document', current, expectedVersion);
      const updated: KnowledgeDocument = {
        ...current,
        ...clone(input),
        name: input.name.trim(),
        importedBy: input.importedBy.trim(),
        version: current.version + 1,
        updatedAt: now().toISOString(),
      };
      data.documents[index] = updated;
      write(data);
      return clone(updated);
    },

    async deleteDocument(id, expectedVersion, signal) {
      await delay(latencyMs, signal);
      const data = read();
      const current = data.documents.find((document) => document.id === id);
      if (!current) {
        throw new KnowledgeNotFoundError('Document', id);
      }
      assertWritable(current.folderUid);
      assertVersion('Document', current, expectedVersion);
      data.documents = data.documents.filter((document) => document.id !== id);
      write(data);
    },

    startImport(input, signal) {
      assertWritable(input.folderUid);
      validateImportFiles(input.files);
      return streamNewImport(input, { read, write, now, newId, importDelayMs }, signal);
    },

    async confirmImport(input, signal) {
      await delay(latencyMs, signal);
      const data = read();
      const index = data.imports.findIndex((task) => task.id === input.taskId);
      const task = data.imports[index];
      if (!task) {
        throw new KnowledgeNotFoundError('Import task', input.taskId);
      }
      assertWritable(task.folderUid);
      if (task.status !== 'reviewing') {
        throw new KnowledgeValidationError('只有 reviewing 状态的导入任务可以确认。');
      }
      const candidates = clone(input.candidates);
      const failed = candidates.filter(({ error }) => error);
      if (failed.length > 0 && !input.skipFailures) {
        throw new KnowledgeValidationError('存在解析失败文件，请选择跳过失败文件后再确认。');
      }
      const timestamp = now().toISOString();
      const documents = candidates
        .filter(({ error }) => !error)
        .map<KnowledgeDocument>((candidate) => ({
          id: newId('doc'),
          folderUid: task.folderUid,
          name: candidate.name,
          format: candidate.format,
          sizeBytes: candidate.sizeBytes,
          chunks: Math.max(1, Math.ceil(candidate.preview.length / 400)),
          tags: candidate.tags,
          serviceId: candidate.serviceId,
          importedBy: candidate.author,
          preview: candidate.preview,
          version: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        }));
      data.documents.unshift(...documents);
      const done: ImportTask = {
        ...task,
        status: 'done',
        progress: 100,
        failed: failed.length,
        candidates,
        createdDocumentIds: documents.map(({ id }) => id),
        updatedAt: timestamp,
      };
      data.imports[index] = done;
      write(data);
      return clone<ImportResult>({ task: done, documents });
    },

    retryImport(taskId, signal) {
      const data = read();
      const task = data.imports.find((candidate) => candidate.id === taskId);
      if (!task) {
        throw new KnowledgeNotFoundError('Import task', taskId);
      }
      assertWritable(task.folderUid);
      return streamExistingImport(task, { read, write, now, importDelayMs }, signal);
    },

    async cancelImport(taskId, signal) {
      await delay(latencyMs, signal);
      const data = read();
      const index = data.imports.findIndex((task) => task.id === taskId);
      const task = data.imports[index];
      if (!task) {
        throw new KnowledgeNotFoundError('Import task', taskId);
      }
      assertWritable(task.folderUid);
      const cancelled = { ...task, status: 'cancelled' as const, updatedAt: now().toISOString() };
      data.imports[index] = cancelled;
      write(data);
      return clone(cancelled);
    },

    async deleteImportTask(taskId, signal) {
      await delay(latencyMs, signal);
      const data = read();
      const task = data.imports.find((candidate) => candidate.id === taskId);
      if (!task) {
        throw new KnowledgeNotFoundError('Import task', taskId);
      }
      assertWritable(task.folderUid);
      if (task.status === 'parsing') {
        throw new KnowledgeValidationError('请先取消正在解析的任务。');
      }
      data.imports = data.imports.filter((candidate) => candidate.id !== taskId);
      write(data);
    },
  };
}

interface StreamDependencies {
  read: () => KnowledgeData;
  write: (data: KnowledgeData) => void;
  now: () => Date;
  importDelayMs: number;
}

async function* streamNewImport(
  input: StartImportInput,
  dependencies: StreamDependencies & { newId: (prefix: string) => string },
  signal: AbortSignal
): AsyncGenerator<ImportTaskEvent> {
  const timestamp = dependencies.now().toISOString();
  const candidates = input.files.map((file) => candidateFrom(file, input.importedBy));
  const task: ImportTask = {
    id: dependencies.newId('imp'),
    folderUid: input.folderUid,
    status: 'parsing',
    progress: 10,
    files: candidates.length,
    failed: 0,
    importedBy: input.importedBy,
    candidates,
    createdDocumentIds: [],
    startedAt: timestamp,
    updatedAt: timestamp,
  };
  const data = dependencies.read();
  data.imports.unshift(task);
  dependencies.write(data);
  yield { type: 'task_updated', payload: clone(task) };
  yield* progressImport(task, dependencies, signal);
}

async function* streamExistingImport(
  existing: ImportTask,
  dependencies: StreamDependencies,
  signal: AbortSignal
): AsyncGenerator<ImportTaskEvent> {
  const task = { ...existing, status: 'parsing' as const, progress: 10, failed: 0 };
  persistTask(task, dependencies);
  yield { type: 'task_updated', payload: clone(task) };
  yield* progressImport(task, dependencies, signal);
}

async function* progressImport(
  task: ImportTask,
  dependencies: StreamDependencies,
  signal: AbortSignal
): AsyncGenerator<ImportTaskEvent> {
  for (const progress of [45, 80]) {
    await delay(dependencies.importDelayMs, signal);
    task.progress = progress;
    task.status = progress === 80 ? 'reviewing' : 'parsing';
    task.failed = progress === 80 ? task.candidates.filter(({ error }) => error).length : 0;
    task.updatedAt = dependencies.now().toISOString();
    persistTask(task, dependencies);
    yield { type: 'task_updated', payload: clone(task) };
  }
}

function persistTask(task: ImportTask, dependencies: StreamDependencies) {
  const data = dependencies.read();
  const index = data.imports.findIndex(({ id }) => id === task.id);
  if (index < 0) {
    data.imports.unshift(task);
  } else {
    data.imports[index] = task;
  }
  dependencies.write(data);
}

function candidateFrom(file: ImportFileDescriptor, author: string): ImportCandidate {
  const error = /(?:fail|broken|损坏)/i.test(file.name) ? '解析失败：文件内容损坏。' : undefined;
  return { ...clone(file), tags: [], author, error };
}

function snapshot(data: KnowledgeData, folderUid: string): KnowledgeSnapshot {
  const services = data.services.filter((item) => item.folderUid === folderUid);
  const runbooks = data.runbooks.filter((item) => item.folderUid === folderUid);
  const documents = data.documents.filter((item) => item.folderUid === folderUid);
  const imports = data.imports.filter((item) => item.folderUid === folderUid);
  return clone({
    folderUid,
    services,
    runbooks,
    documents,
    imports,
    counts: {
      services: services.length,
      runbooks: runbooks.length,
      documents: documents.length,
      imports: imports.length,
    },
  });
}

function readData(storage: Pick<Storage, 'getItem' | 'setItem'>, storageKey: string): KnowledgeData {
  try {
    const raw = storage.getItem(storageKey);
    const parsed: unknown = raw ? JSON.parse(raw) : undefined;
    if (isKnowledgeData(parsed)) {
      return clone(parsed);
    }
  } catch {
    // Fall through to a clean seed.
  }
  const seeded = clone(knowledgeFixtureData);
  storage.setItem(storageKey, JSON.stringify(seeded));
  return seeded;
}

function isKnowledgeData(value: unknown): value is KnowledgeData {
  return (
    typeof value === 'object' &&
    value !== null &&
    'schemaVersion' in value &&
    value.schemaVersion === 1 &&
    'services' in value &&
    Array.isArray(value.services) &&
    'runbooks' in value &&
    Array.isArray(value.runbooks) &&
    'documents' in value &&
    Array.isArray(value.documents) &&
    'imports' in value &&
    Array.isArray(value.imports)
  );
}

function validateService(input: CreateServiceInput | UpdateServiceInput) {
  if (!/^[A-Za-z0-9_-]+$/.test(input.name.trim())) {
    throw new KnowledgeValidationError('Service 名称只能包含字母、数字、下划线和连字符。');
  }
  if (!input.displayName.trim() || !input.owner.trim()) {
    throw new KnowledgeValidationError('Display name 和 Owner 不能为空。');
  }
}

function validateRunbook(input: CreateRunbookInput | UpdateRunbookInput) {
  if (!input.title.trim() || !input.author.trim() || !input.body.trim()) {
    throw new KnowledgeValidationError('标题、作者和正文不能为空。');
  }
}

function validateDocument(input: UpdateDocumentInput) {
  if (!input.name.trim() || !input.importedBy.trim()) {
    throw new KnowledgeValidationError('文件名和导入人不能为空。');
  }
}

function validateImportFiles(files: ImportFileDescriptor[]) {
  if (files.length === 0) {
    throw new KnowledgeValidationError('请选择至少一个文件。');
  }
  if (files.length > 100) {
    throw new KnowledgeValidationError('单次最多导入 100 个文件。');
  }
  if (files.some(({ sizeBytes }) => sizeBytes > 10 * 1024 * 1024)) {
    throw new KnowledgeValidationError('单文件不能超过 10MB。');
  }
}

function assertVersion(
  resource: string,
  current: { id: string; version: number },
  expectedVersion: number
) {
  if (current.version !== expectedVersion) {
    throw new KnowledgeVersionConflictError(resource, current.id);
  }
}

function syncRunbookCounts(data: KnowledgeData) {
  data.services = data.services.map((service) => ({
    ...service,
    runbookCount: data.runbooks.filter(({ serviceId }) => serviceId === service.id).length,
  }));
}

function delay(durationMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(abortError());
  }
  if (durationMs <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, durationMs);
    const onAbort = () => {
      window.clearTimeout(timeout);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
