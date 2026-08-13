import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { useAppServices } from '../../app/AppServices';
import { useAppShell } from '../../app/AppShellContext';
import { useKnowledgeController } from './application/useKnowledgeController';
import { ConfirmDialog } from './components/ConfirmDialog';
import { DocumentEditModal } from './components/DocumentEditModal';
import { DocumentPreviewModal, DocumentsView } from './components/DocumentsView';
import { ImportResultModal, ImportReviewModal } from './components/ImportReviewModal';
import { ImportsView } from './components/ImportsView';
import { KnowledgeSidebar } from './components/KnowledgeSidebar';
import { RunbookFormModal } from './components/RunbookFormModal';
import { RunbookHistoryModal, RunbooksView } from './components/RunbooksView';
import { ServiceFormModal } from './components/ServiceFormModal';
import { ServicesView, YamlPreview } from './components/ServicesView';
import {
  CreateRunbookInput,
  CreateServiceInput,
  DocumentFormat,
  ImportFileDescriptor,
  ImportTask,
  KnowledgeDocument,
  KnowledgeTab,
  Runbook,
  ServiceEntry,
  UpdateDocumentInput,
} from './model';
import './knowledge.css';

export default function KnowledgePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { knowledgeGateway } = useAppServices();
  const { activeFolder, folders, refreshFolders, setActiveFolder } = useAppShell();
  const controller = useKnowledgeController({ activeFolder, gateway: knowledgeGateway });
  const { resetMutation, stopImport } = controller;
  const tab = parseKnowledgeTab(searchParams.get('tab'));
  const query = searchParams.get('query') ?? searchParams.get('q') ?? '';
  const selectedRunbookId = searchParams.get('runbook') ?? undefined;
  const [selectedServiceId, setSelectedServiceId] = useState<string>();
  const [serviceForm, setServiceForm] = useState<{ mode: 'create' } | { mode: 'edit'; service: ServiceEntry }>();
  const [deleteService, setDeleteService] = useState<ServiceEntry>();
  const [yamlOpen, setYamlOpen] = useState(false);
  const [runbookForm, setRunbookForm] = useState<{ mode: 'create' } | { mode: 'edit'; runbook: Runbook }>();
  const [deleteRunbook, setDeleteRunbook] = useState<Runbook>();
  const [historyRunbook, setHistoryRunbook] = useState<Runbook>();
  const [editDocument, setEditDocument] = useState<KnowledgeDocument>();
  const [deleteDocument, setDeleteDocument] = useState<KnowledgeDocument>();
  const [previewDocument, setPreviewDocument] = useState<KnowledgeDocument>();
  const [reviewTask, setReviewTask] = useState<ImportTask>();
  const [resultTask, setResultTask] = useState<ImportTask>();
  const [fileError, setFileError] = useState<string>();
  const importScopeRef = useRef(0);
  const previousFolderUidRef = useRef(activeFolder?.uid);
  // Never render a previous Folder's records while the new scoped request is
  // in flight. The controller also rejects stale responses, but this guard
  // closes the one-render gap before the effect schedules the new load.
  const scopedSnapshotState =
    controller.snapshot.status === 'success' && controller.snapshot.data.folderUid !== activeFolder?.uid
      ? ({ status: 'loading' } as const)
      : controller.snapshot;
  const snapshot = scopedSnapshotState.status === 'success' ? scopedSnapshotState.data : undefined;
  const services = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return (snapshot?.services ?? []).filter((service) =>
      normalized
        ? `${service.name} ${service.displayName} ${service.owner}`.toLocaleLowerCase().includes(normalized)
        : true
    );
  }, [query, snapshot?.services]);
  const selectedService = services.find(({ id }) => id === selectedServiceId) ?? services[0];
  const runbooks = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return (snapshot?.runbooks ?? []).filter((runbook) =>
      normalized
        ? `${runbook.title} ${runbook.author} ${runbook.tags.join(' ')}`.toLocaleLowerCase().includes(normalized)
        : true
    );
  }, [query, snapshot?.runbooks]);
  const selectedRunbook = runbooks.find(({ id }) => id === selectedRunbookId) ?? runbooks[0];
  const mutating = controller.mutation.status === 'loading';

  const updateSearchParams = (updates: Record<string, string | undefined>, replace = true) => {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        Object.entries(updates).forEach(([key, value]) => {
          if (value === undefined || value === '') {
            next.delete(key);
          } else {
            next.set(key, value);
          }
        });
        return next;
      },
      { replace }
    );
  };

  useEffect(() => {
    const previousFolderUid = previousFolderUidRef.current;
    previousFolderUidRef.current = activeFolder?.uid;

    // Preserve a deep-link's query on the initial Folder load. Once the user
    // moves between already-resolved scopes, every resource-local selection
    // and dialog must be discarded, including changes made from the global
    // topbar Folder dropdown.
    if (previousFolderUid === undefined || previousFolderUid === activeFolder?.uid) {
      return;
    }

    importScopeRef.current += 1;
    stopImport();
    resetMutation();
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete('query');
        next.delete('q');
        next.delete('runbook');
        return next;
      },
      { replace: true }
    );
    setSelectedServiceId(undefined);
    setServiceForm(undefined);
    setDeleteService(undefined);
    setYamlOpen(false);
    setRunbookForm(undefined);
    setDeleteRunbook(undefined);
    setHistoryRunbook(undefined);
    setEditDocument(undefined);
    setDeleteDocument(undefined);
    setPreviewDocument(undefined);
    setReviewTask(undefined);
    setResultTask(undefined);
    setFileError(undefined);
  }, [activeFolder?.uid, resetMutation, stopImport, setSearchParams]);

  const updateQuery = (value: string) => {
    updateSearchParams({ query: value, q: undefined });
  };

  const selectRunbook = (id?: string) => {
    updateSearchParams({ runbook: id });
  };

  const changeFolder = (uid: string) => {
    setActiveFolder(uid);
  };

  const submitRunbook = async (input: CreateRunbookInput) => {
    const editing = runbookForm?.mode === 'edit' ? runbookForm.runbook : undefined;
    const result = editing
      ? await controller.updateRunbook(
          editing.id,
          {
            title: input.title,
            serviceId: input.serviceId,
            tags: input.tags,
            severity: input.severity,
            author: input.author,
            source: input.source,
            excerpt: input.excerpt,
            body: input.body,
          },
          editing.version
        )
      : await controller.createRunbook(input);
    if (result) {
      setRunbookForm(undefined);
      selectRunbook(result.id);
    }
  };

  const beginImport = async (files: File[]) => {
    if (!activeFolder || !controller.writable) {
      return;
    }
    const scope = importScopeRef.current;
    const folderUid = activeFolder.uid;
    setFileError(undefined);
    try {
      const descriptors = await Promise.all(files.map(fileDescriptor));
      if (scope !== importScopeRef.current || !activeFolder || activeFolder.uid !== folderUid || !controller.writable) {
        return;
      }
      updateSearchParams({ tab: 'imports', query: undefined, q: undefined, runbook: undefined });
      await controller.startImport({ folderUid, importedBy: 'alice', files: descriptors });
    } catch (error) {
      // File reads can finish after the user changes Folder. Do not surface an
      // error from the old import attempt in the newly selected scope.
      if (scope === importScopeRef.current && activeFolder?.uid === folderUid) {
        setFileError(error instanceof Error ? error.message : '文件读取失败。');
      }
    }
  };

  const submitDocument = async (input: UpdateDocumentInput) => {
    if (!editDocument) {
      return;
    }
    const updated = await controller.updateDocument(editDocument.id, input, editDocument.version);
    if (updated) {
      setEditDocument(undefined);
    }
  };

  const submitService = async (input: CreateServiceInput) => {
    const editing = serviceForm?.mode === 'edit' ? serviceForm.service : undefined;
    const result = editing
      ? await controller.updateService(
          editing.id,
          {
            name: input.name,
            displayName: input.displayName,
            owner: input.owner,
            tier: input.tier,
            keyMetrics: input.keyMetrics,
          },
          editing.version
        )
      : await controller.createService(input);
    if (result) {
      setServiceForm(undefined);
      setSelectedServiceId(result.id);
    }
  };

  return (
    <main className="knowledge-page">
      <KnowledgeSidebar
        activeFolder={activeFolder}
        folderLoading={folders.status === 'loading'}
        folders={folders.status === 'success' ? folders.data : []}
        onFolderChange={changeFolder}
        onRefreshFolders={refreshFolders}
        onTabChange={(next) => {
          updateSearchParams(
            {
              tab: next === 'services' ? undefined : next,
              query: undefined,
              q: undefined,
              runbook: next === 'runbooks' ? selectedRunbookId : undefined,
            },
            false
          );
        }}
        snapshot={scopedSnapshotState}
        tab={tab}
      />
      <section aria-label="Knowledge 内容" className="knowledge-content">
        {scopedSnapshotState.status === 'idle' && <div className="knowledge-state">正在等待 Folder…</div>}
        {scopedSnapshotState.status === 'loading' && <div className="knowledge-state">正在加载 Knowledge…</div>}
        {scopedSnapshotState.status === 'error' && (
          <div className="knowledge-state error">
            <AlertCircle aria-hidden size={24} />
            <strong>Knowledge 加载失败</strong>
            <span>{scopedSnapshotState.error.message}</span>
            <button className="knowledge-button secondary" onClick={() => void controller.retry()} type="button">
              重试
            </button>
          </div>
        )}
        {activeFolder && snapshot && tab === 'services' && (
          <ServicesView
            folder={activeFolder}
            onCreate={() => setServiceForm({ mode: 'create' })}
            onDelete={setDeleteService}
            onEdit={(service) => setServiceForm({ mode: 'edit', service })}
            onQueryChange={updateQuery}
            onSelect={setSelectedServiceId}
            onYaml={() => setYamlOpen(true)}
            query={query}
            selected={selectedService}
            services={services}
            writable={controller.writable}
          />
        )}
        {activeFolder && snapshot && tab === 'runbooks' && (
          <RunbooksView
            folder={activeFolder}
            onCreate={() => setRunbookForm({ mode: 'create' })}
            onDelete={setDeleteRunbook}
            onEdit={(runbook) => setRunbookForm({ mode: 'edit', runbook })}
            onHistory={setHistoryRunbook}
            onQueryChange={updateQuery}
            onSelect={selectRunbook}
            query={query}
            runbooks={runbooks}
            selected={selectedRunbook}
            services={snapshot.services}
            writable={controller.writable}
          />
        )}
        {activeFolder && snapshot && tab === 'documents' && (
          <DocumentsView
            documents={snapshot.documents}
            folder={activeFolder}
            onDelete={setDeleteDocument}
            onEdit={setEditDocument}
            onFiles={(files) => void beginImport(files)}
            onPreview={setPreviewDocument}
            services={snapshot.services}
            writable={controller.writable}
          />
        )}
        {activeFolder && snapshot && tab === 'imports' && (
          <ImportsView
            folder={activeFolder}
            importing={controller.importing}
            imports={snapshot.imports}
            onCancel={(task) => {
              controller.stopImport();
              void controller.cancelImport(task.id);
            }}
            onDelete={(task) => void controller.deleteImportTask(task.id)}
            onFiles={(files) => void beginImport(files)}
            onOpen={(task) => (task.status === 'reviewing' ? setReviewTask(task) : setResultTask(task))}
            onRetry={(task) => void controller.retryImport(task.id)}
            writable={controller.writable}
          />
        )}
        {controller.mutation.status === 'error' && (
          <div className="knowledge-toast error" role="alert">
            <AlertCircle aria-hidden size={14} />
            <span>{controller.mutation.error.message}</span>
            <button aria-label="关闭错误" onClick={controller.resetMutation} type="button">
              ×
            </button>
          </div>
        )}
        {fileError && (
          <div className="knowledge-toast error" role="alert">
            <AlertCircle aria-hidden size={14} />
            <span>{fileError}</span>
            <button aria-label="关闭文件错误" onClick={() => setFileError(undefined)} type="button">
              ×
            </button>
          </div>
        )}
      </section>
      {activeFolder && serviceForm && (
        <ServiceFormModal
          folderUid={activeFolder.uid}
          initial={serviceForm.mode === 'edit' ? serviceForm.service : undefined}
          key={serviceForm.mode === 'edit' ? serviceForm.service.id : 'create'}
          onClose={() => setServiceForm(undefined)}
          onSubmit={(input) => void submitService(input)}
          saving={mutating}
        />
      )}
      {deleteService && (
        <ConfirmDialog
          confirming={mutating}
          onCancel={() => setDeleteService(undefined)}
          onConfirm={() =>
            void controller.deleteService(deleteService.id, deleteService.version).then((deleted) => {
              if (deleted) {
                setDeleteService(undefined);
                setSelectedServiceId(undefined);
              }
            })
          }
          title={`删除 @${deleteService.name}`}
        >
          删除后，关联的 Runbook 和文档会保留，但不再关联此服务。
        </ConfirmDialog>
      )}
      {yamlOpen && <YamlPreview onClose={() => setYamlOpen(false)} services={snapshot?.services ?? []} />}
      {activeFolder && runbookForm && (
        <RunbookFormModal
          folderUid={activeFolder.uid}
          initial={runbookForm.mode === 'edit' ? runbookForm.runbook : undefined}
          key={runbookForm.mode === 'edit' ? runbookForm.runbook.id : 'create-runbook'}
          onClose={() => setRunbookForm(undefined)}
          onSubmit={(input) => void submitRunbook(input)}
          saving={mutating}
          services={snapshot?.services ?? []}
        />
      )}
      {deleteRunbook && (
        <ConfirmDialog
          confirming={mutating}
          onCancel={() => setDeleteRunbook(undefined)}
          onConfirm={() =>
            void controller.deleteRunbook(deleteRunbook.id, deleteRunbook.version).then((deleted) => {
              if (deleted) {
                setDeleteRunbook(undefined);
                selectRunbook(undefined);
              }
            })
          }
          title={`删除 Runbook ${deleteRunbook.title}`}
        >
          删除后不会删除关联的服务。
        </ConfirmDialog>
      )}
      {historyRunbook && <RunbookHistoryModal onClose={() => setHistoryRunbook(undefined)} runbook={historyRunbook} />}
      {editDocument && (
        <DocumentEditModal
          document={editDocument}
          key={editDocument.id}
          onClose={() => setEditDocument(undefined)}
          onSubmit={(input) => void submitDocument(input)}
          saving={mutating}
          services={snapshot?.services ?? []}
        />
      )}
      {deleteDocument && (
        <ConfirmDialog
          confirming={mutating}
          onCancel={() => setDeleteDocument(undefined)}
          onConfirm={() =>
            void controller.deleteDocument(deleteDocument.id, deleteDocument.version).then((deleted) => {
              if (deleted) {
                setDeleteDocument(undefined);
              }
            })
          }
          title={`删除文档 ${deleteDocument.name}`}
        >
          删除后，该文档的索引信息和预览将无法恢复。
        </ConfirmDialog>
      )}
      {previewDocument && (
        <DocumentPreviewModal
          document={previewDocument}
          onClose={() => setPreviewDocument(undefined)}
          services={snapshot?.services ?? []}
        />
      )}
      {reviewTask && (
        <ImportReviewModal
          key={`${reviewTask.id}-${reviewTask.updatedAt}`}
          onClose={() => setReviewTask(undefined)}
          onConfirm={(input) =>
            void controller.confirmImport(input).then((result) => {
              if (result) {
                setReviewTask(undefined);
                setResultTask(result.task);
              }
            })
          }
          saving={mutating}
          services={snapshot?.services ?? []}
          task={reviewTask}
          writable={controller.writable}
        />
      )}
      {resultTask && <ImportResultModal onClose={() => setResultTask(undefined)} task={resultTask} />}
    </main>
  );
}

async function fileDescriptor(file: File, index: number): Promise<ImportFileDescriptor> {
  if (file.size > 10 * 1024 * 1024) {
    throw new Error(`${file.name} 超过 10MB。`);
  }
  const format = formatFromName(file.name);
  const preview = ['md', 'txt', 'html'].includes(format)
    ? (await readText(file)).slice(0, 4096)
    : `${file.name} 暂不支持浏览器内内容预览。`;
  return {
    id: `file-${Date.now()}-${index}`,
    name: file.name,
    format,
    sizeBytes: file.size,
    preview: preview || `${file.name} 是一个空文本文件。`,
  };
}

function formatFromName(name: string): DocumentFormat {
  const extension = name.split('.').at(-1)?.toLocaleLowerCase();
  if (extension === 'md' || extension === 'pdf' || extension === 'docx' || extension === 'txt') {
    return extension;
  }
  if (extension === 'html' || extension === 'htm') {
    return 'html';
  }
  if (extension === 'zip') {
    return 'confluence';
  }
  throw new Error(`${name} 的文件格式不受支持。`);
}

function parseKnowledgeTab(value: string | null): KnowledgeTab {
  return value === 'runbooks' || value === 'documents' || value === 'imports' ? value : 'services';
}

function readText(file: File): Promise<string> {
  if (typeof file.text === 'function') {
    return file.text();
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`${file.name} 读取失败。`));
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.readAsText(file);
  });
}
