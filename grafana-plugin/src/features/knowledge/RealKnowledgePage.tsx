import React, { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Download, FileText, Plus, RefreshCw, Search, Trash2, Upload } from 'lucide-react';
import { useAppShell } from '../../app/AppShellContext';
import {
  KnowledgeBaseRecord,
  DocumentPassageRecord,
  KnowledgeAvailability,
  KnowledgeDocumentRecord,
  KnowledgeSearchHit,
} from './managementModel';
import { KnowledgeManagementGateway } from './ports/KnowledgeManagementGateway';
import './knowledge.css';

type Loadable<T> = { status: 'loading' } | { status: 'error'; error: Error } | { status: 'success'; data: T };
type Tab = 'documents' | 'search';
type PassageTarget = { knowledgeBaseId: string; documentId: string; ordinal: number; request: number };

export default function RealKnowledgePage({ gateway }: { gateway: KnowledgeManagementGateway }) {
  const { activeFolder } = useAppShell();
  const folderUid = activeFolder?.uid;
  const writable = activeFolder?.permission === 'Edit' || activeFolder?.permission === 'Admin';
  const admin = activeFolder?.permission === 'Admin';
  const [availability, setAvailability] = useState<Loadable<KnowledgeAvailability>>({ status: 'loading' });
  const [bases, setBases] = useState<Loadable<KnowledgeBaseRecord[]>>({ status: 'loading' });
  const [selectedBaseId, setSelectedBaseId] = useState<string>();
  const [documents, setDocuments] = useState<Loadable<KnowledgeDocumentRecord[]>>({ status: 'loading' });
  const [tab, setTab] = useState<Tab>('documents');
  const [passageTarget, setPassageTarget] = useState<PassageTarget>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [refreshBases, setRefreshBases] = useState(0);
  const [refreshDocuments, setRefreshDocuments] = useState(0);
  const selectedBase = bases.status === 'success' ? bases.data.find(({ id }) => id === selectedBaseId) : undefined;

  useEffect(() => {
    const controller = new AbortController();
    void gateway
      .getAvailability(controller.signal)
      .then((data) => !controller.signal.aborted && setAvailability({ status: 'success', data }))
      .catch(
        (error: unknown) =>
          !isAbortError(error) && setAvailability({ status: 'error', error: toError(error) })
      );
    return () => controller.abort();
  }, [gateway]);

  useEffect(() => {
    if (!folderUid || availability.status !== 'success' || availability.data.status === 'unavailable') {
      return;
    }
    const controller = new AbortController();
    // Folder 切换时同步隐藏上一作用域数据，避免请求完成前短暂泄漏旧 Folder 内容。
    /* eslint-disable react-hooks/set-state-in-effect */
    setBases({ status: 'loading' });
    setSelectedBaseId(undefined);
    /* eslint-enable react-hooks/set-state-in-effect */
    void gateway
      .listKnowledgeBases(folderUid, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) {
          return;
        }
        setBases({ status: 'success', data });
        setSelectedBaseId(data[0]?.id);
      })
      .catch((error: unknown) => !isAbortError(error) && setBases({ status: 'error', error: toError(error) }));
    return () => controller.abort();
  }, [availability, folderUid, gateway, refreshBases]);

  const loadDocuments = useCallback(
    (signal?: AbortSignal) => {
      if (!folderUid || !selectedBaseId) {
        return Promise.resolve([]);
      }
      return gateway.listDocuments(folderUid, selectedBaseId, signal);
    },
    [folderUid, gateway, selectedBaseId]
  );

  useEffect(() => {
    if (!folderUid || !selectedBaseId) {
      /* eslint-disable react-hooks/set-state-in-effect */
      setDocuments({ status: 'success', data: [] });
      /* eslint-enable react-hooks/set-state-in-effect */
      return;
    }
    const controller = new AbortController();
    setDocuments({ status: 'loading' });
    void loadDocuments(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) {
          setDocuments({ status: 'success', data });
        }
      })
      .catch((error: unknown) => !isAbortError(error) && setDocuments({ status: 'error', error: toError(error) }));
    return () => controller.abort();
  }, [folderUid, loadDocuments, refreshDocuments, selectedBaseId]);

  // 只在自动索引队列仍有工作时轮询，离开 Folder/KB 立即取消。
  useEffect(() => {
    if (
      documents.status !== 'success' ||
      !documents.data.some(({ status }) => status === 'queued' || status === 'indexing')
    ) {
      return;
    }
    const timer = window.setTimeout(() => setRefreshDocuments((value) => value + 1), 3000);
    return () => window.clearTimeout(timer);
  }, [documents]);

  const mutate = async (operation: () => Promise<void>, success: string) => {
    setBusy(true);
    setNotice(undefined);
    try {
      await operation();
      setNotice(success);
    } catch (error) {
      setNotice(toError(error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!folderUid) {
    return <State text="请先在 Grafana 创建 Folder，或联系管理员授予 Folder 权限。" />;
  }
  if (availability.status === 'loading') {
    return <State text="正在检查 Knowledge 能力…" />;
  }
  if (availability.status === 'error') {
    return <ErrorState error={availability.error} retry={() => window.location.reload()} />;
  }
  if (availability.data.status === 'unavailable') {
    return <State text={`Knowledge 未配置：${availability.data.reason || '服务不可用'}`} />;
  }
  if (bases.status === 'loading') {
    return <State text="正在加载知识库…" />;
  }
  if (bases.status === 'error') {
    return <ErrorState error={bases.error} retry={() => setRefreshBases((value) => value + 1)} />;
  }

  const createBase = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get('name') ?? '').trim();
    if (!name) {
      return;
    }
    await mutate(async () => {
      const created = await gateway.createKnowledgeBase(folderUid, name, operationKey('kb'));
      setBases({ status: 'success', data: [...bases.data, created] });
      setSelectedBaseId(created.id);
      event.currentTarget.reset();
    }, '知识库已创建。');
  };

  return (
    <main className="knowledge-management-page">
      <aside className="knowledge-management-sidebar">
        <header>
          <strong>Knowledge Bases</strong>
          <span>{activeFolder?.title}</span>
        </header>
        {bases.data.map((base) => (
          <button
            className={base.id === selectedBaseId ? 'active' : ''}
            key={base.id}
            onClick={() => setSelectedBaseId(base.id)}
            type="button"
          >
            <span>{base.name}</span>
          </button>
        ))}
        {bases.data.length === 0 && <p>此 Folder 尚无知识库。</p>}
        {writable && (
          <form className="knowledge-inline-form" onSubmit={createBase}>
            <input aria-label="知识库名称" name="name" placeholder="新知识库名称" />
            <button disabled={busy} type="submit">
              <Plus size={13} /> 新建
            </button>
          </form>
        )}
      </aside>
      <section className="knowledge-management-content">
        {availability.data.status === 'degraded' && (
          <div className="knowledge-permission-banner">Knowledge 当前降级：{availability.data.reason || '部分能力不可用'}</div>
        )}
        {!selectedBase ? (
          <State text="创建或选择一个知识库后开始管理文档。" />
        ) : (
          <>
            <header className="knowledge-page-header">
              <div>
                <h1>{selectedBase.name}</h1>
                <p>Folder: {activeFolder?.title}</p>
              </div>
              {writable && (
                <KnowledgeBaseActions
                  base={selectedBase}
                  busy={busy}
                  canDelete={admin}
                  onMutate={mutate}
                  gateway={gateway}
                  folderUid={folderUid}
                  refresh={() => setRefreshBases((value) => value + 1)}
                />
              )}
            </header>
            {notice && (
              <div className="knowledge-management-notice" role="status">
                {notice}
              </div>
            )}
            {!writable && (
              <div className="knowledge-permission-banner">
                当前 Folder 仅有查看权限；服务端会继续执行最终权限校验。
              </div>
            )}
            <nav className="knowledge-management-tabs" aria-label="知识库功能">
              {(['documents', 'search'] as Tab[]).map((item) => (
                <button className={tab === item ? 'active' : ''} key={item} onClick={() => setTab(item)} type="button">
                  {tabLabel(item)}
                </button>
              ))}
            </nav>
            {tab === 'documents' && (
              <DocumentsPanel
                busy={busy}
                documents={documents}
                folderUid={folderUid}
                gateway={gateway}
                knowledgeBaseId={selectedBase.id}
                mutate={mutate}
                passageTarget={passageTarget}
                refresh={() => setRefreshDocuments((value) => value + 1)}
                writable={writable}
              />
            )}
            {tab === 'search' && (
              <SearchPanel
                bases={bases.data}
                folderUid={folderUid}
                gateway={gateway}
                key={selectedBase.id}
                knowledgeBaseId={selectedBase.id}
                openCitation={(citation) => {
                  setPassageTarget({
                    knowledgeBaseId: citation.knowledge_base_id,
                    documentId: citation.document_id,
                    ordinal: citation.ordinal,
                    request: Date.now(),
                  });
                  setSelectedBaseId(citation.knowledge_base_id);
                  setTab('documents');
                }}
              />
            )}
          </>
        )}
      </section>
    </main>
  );
}

function KnowledgeBaseActions({
  base,
  busy,
  canDelete,
  folderUid,
  gateway,
  onMutate,
  refresh,
}: {
  base: KnowledgeBaseRecord;
  busy: boolean;
  canDelete: boolean;
  folderUid: string;
  gateway: KnowledgeManagementGateway;
  onMutate: (operation: () => Promise<void>, success: string) => Promise<void>;
  refresh: () => void;
}) {
  const remove = () => {
    if (!window.confirm(`删除知识库“${base.name}”？`)) {
      return;
    }
    void onMutate(async () => {
      await gateway.deleteKnowledgeBase(folderUid, base.id);
      refresh();
    }, '知识库已删除。');
  };
  return (
    <div className="knowledge-header-actions">
      <form
        className="knowledge-rename-form"
        onSubmit={(event) => {
          event.preventDefault();
          const name = String(new FormData(event.currentTarget).get('name') ?? '').trim();
          if (name && name !== base.name) {
            void onMutate(async () => {
              await gateway.updateKnowledgeBase(folderUid, base.id, { name });
              refresh();
            }, '知识库名称已更新。');
          }
        }}
      >
        <input aria-label="修改知识库名称" defaultValue={base.name} name="name" />
        <button className="knowledge-button secondary" disabled={busy} type="submit">
          保存名称
        </button>
      </form>
      {canDelete && (
        <button className="knowledge-button danger" disabled={busy} onClick={remove} type="button">
          <Trash2 size={13} /> 删除
        </button>
      )}
    </div>
  );
}

function DocumentsPanel({
  busy,
  documents,
  folderUid,
  gateway,
  knowledgeBaseId,
  mutate,
  passageTarget,
  refresh,
  writable,
}: {
  busy: boolean;
  documents: Loadable<KnowledgeDocumentRecord[]>;
  folderUid: string;
  gateway: KnowledgeManagementGateway;
  knowledgeBaseId: string;
  mutate: (operation: () => Promise<void>, success: string) => Promise<void>;
  passageTarget?: PassageTarget;
  refresh: () => void;
  writable: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const passagesAbortRef = useRef<AbortController>();
  const [passages, setPassages] = useState<{
    document: KnowledgeDocumentRecord;
    ordinal?: number;
    state: Loadable<DocumentPassageRecord[]>;
  }>();
  useEffect(() => () => passagesAbortRef.current?.abort(), []);
  const upload = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    const file = fileInputRef.current?.files?.[0];
    if (!file || file.size === 0) {
      return;
    }
    await mutate(async () => {
      await gateway.uploadDocument(folderUid, knowledgeBaseId, {
        file,
        service: String(form.get('service') ?? '').trim(),
        tags: splitTags(String(form.get('tags') ?? '')),
        idempotencyKey: operationKey('upload'),
      });
      element.reset();
      refresh();
    }, '文档已上传，等待解析。');
  };
  const showPassages = useCallback((document: KnowledgeDocumentRecord, ordinal?: number) => {
    passagesAbortRef.current?.abort();
    const controller = new AbortController();
    passagesAbortRef.current = controller;
    setPassages({ document, state: { status: 'loading' }, ordinal });
    void gateway
      .listPassages(folderUid, knowledgeBaseId, document.id, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) {
          setPassages({ document, state: { status: 'success', data }, ordinal });
        }
      })
      .catch(
        (error: unknown) =>
          !isAbortError(error) && setPassages({ document, state: { status: 'error', error: toError(error) }, ordinal })
      );
  }, [folderUid, gateway, knowledgeBaseId]);

  useEffect(() => {
    if (!passageTarget || passageTarget.knowledgeBaseId !== knowledgeBaseId || documents.status !== 'success') {
      return;
    }
    const document = documents.data.find(({ id }) => id === passageTarget.documentId);
    if (document) {
      showPassages(document, passageTarget.ordinal);
    }
  }, [documents, knowledgeBaseId, passageTarget, showPassages]);
  const download = async (document: KnowledgeDocumentRecord) => {
    await mutate(async () => {
      const blob = await gateway.downloadDocument(folderUid, knowledgeBaseId, document.id);
      const url = URL.createObjectURL(blob);
      const anchor = window.document.createElement('a');
      anchor.href = url;
      anchor.download = document.name;
      anchor.click();
      URL.revokeObjectURL(url);
    }, '原始文档已开始下载。');
  };
  if (documents.status === 'loading') {
    return <State text="正在加载文档…" />;
  }
  if (documents.status === 'error') {
    return <ErrorState error={documents.error} retry={refresh} />;
  }
  return (
    <>
      {writable && (
        <form className="knowledge-upload-form" onSubmit={upload}>
          <input
            accept=".pdf,.md,.txt"
            aria-label="选择文档"
            name="file"
            ref={fileInputRef}
            required
            type="file"
          />
          <input aria-label="所属服务" name="service" placeholder="服务（可选）" />
          <input aria-label="文档标签" name="tags" placeholder="标签，逗号分隔" />
          <button className="knowledge-button primary" disabled={busy} type="submit">
            <Upload size={13} /> 上传
          </button>
        </form>
      )}
      <section aria-label="文档列表" className="knowledge-document-list">
        {documents.data.map((document) => (
          <article key={document.id}>
            <FileText size={18} />
            <div>
              <strong>{document.name}</strong>
              <p>
                {document.media_type} · {formatSize(document.size)} · {document.service || '未绑定服务'}
              </p>
              {document.failure_reason && <p className="error">{document.failure_reason}</p>}
            </div>
            <span className={`knowledge-status ${document.status}`}>{document.status}</span>
            <div className="knowledge-document-actions">
              <button onClick={() => showPassages(document)} type="button">
                段落
              </button>
              <button aria-label={`下载 ${document.name}`} onClick={() => void download(document)} type="button">
                <Download size={13} />
              </button>
              {writable && (
                <>
                  <DocumentWriteActions
                    busy={busy}
                    document={document}
                    folderUid={folderUid}
                    gateway={gateway}
                    knowledgeBaseId={knowledgeBaseId}
                    mutate={mutate}
                    refresh={refresh}
                  />
                  <DocumentMetadataForm
                    busy={busy}
                    document={document}
                    folderUid={folderUid}
                    gateway={gateway}
                    knowledgeBaseId={knowledgeBaseId}
                    mutate={mutate}
                    refresh={refresh}
                  />
                </>
              )}
            </div>
          </article>
        ))}
        {documents.data.length === 0 && (
          <div className="knowledge-empty">尚无文档。上传 PDF、Markdown 或 TXT 文件后会自动构建索引。</div>
        )}
      </section>
      {passages && (
        <PassagesPanel
          close={() => setPassages(undefined)}
          document={passages.document}
          focusedOrdinal={passages.ordinal}
          state={passages.state}
        />
      )}
    </>
  );
}

function DocumentMetadataForm({
  busy,
  document,
  folderUid,
  gateway,
  knowledgeBaseId,
  mutate,
  refresh,
}: {
  busy: boolean;
  document: KnowledgeDocumentRecord;
  folderUid: string;
  gateway: KnowledgeManagementGateway;
  knowledgeBaseId: string;
  mutate: (operation: () => Promise<void>, success: string) => Promise<void>;
  refresh: () => void;
}) {
  return (
    <details className="knowledge-metadata-editor">
      <summary>元数据</summary>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          void mutate(async () => {
            await gateway.updateDocument(folderUid, knowledgeBaseId, document.id, {
              service: String(form.get('service') ?? '').trim(),
              tags: splitTags(String(form.get('tags') ?? '')),
            });
            refresh();
          }, '文档元数据已更新。');
        }}
      >
        <input aria-label={`${document.name} 服务`} defaultValue={document.service} name="service" />
        <input aria-label={`${document.name} 标签`} defaultValue={document.tags.join(', ')} name="tags" />
        <button disabled={busy} type="submit">
          保存
        </button>
      </form>
    </details>
  );
}

function DocumentWriteActions({
  busy,
  document,
  folderUid,
  gateway,
  knowledgeBaseId,
  mutate,
  refresh,
}: {
  busy: boolean;
  document: KnowledgeDocumentRecord;
  folderUid: string;
  gateway: KnowledgeManagementGateway;
  knowledgeBaseId: string;
  mutate: (operation: () => Promise<void>, success: string) => Promise<void>;
  refresh: () => void;
}) {
  const remove = () => {
    if (window.confirm(`删除文档“${document.name}”？`)) {
      void mutate(async () => {
        await gateway.deleteDocument(folderUid, knowledgeBaseId, document.id);
        refresh();
      }, '文档已删除。');
    }
  };
  return (
    <>
      {document.status === 'failed' && (
        <button
          disabled={busy}
          onClick={() =>
            void mutate(async () => {
              await gateway.retryDocumentIndex(folderUid, knowledgeBaseId, document.id);
              refresh();
            }, '文档已重新进入索引队列。')
          }
          type="button"
        >
          重试索引
        </button>
      )}
      <button aria-label={`删除 ${document.name}`} disabled={busy} onClick={remove} type="button">
        <Trash2 size={13} />
      </button>
    </>
  );
}

function PassagesPanel({
  close,
  document,
  focusedOrdinal,
  state,
}: {
  close: () => void;
  document: KnowledgeDocumentRecord;
  focusedOrdinal?: number;
  state: Loadable<DocumentPassageRecord[]>;
}) {
  return (
    <section className="knowledge-chunks">
      <header>
        <strong>{document.name} 的段落</strong>
        <button onClick={close} type="button">
          关闭
        </button>
      </header>
      {state.status === 'loading' ? (
        <State text="正在加载段落…" />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} retry={close} />
      ) : (
        state.data.map((passage) => (
          <article aria-current={passage.ordinal === focusedOrdinal ? 'true' : undefined} key={passage.ordinal}>
            <small>{passage.location || `段落 ${passage.ordinal}`}</small>
            <p>{passage.text}</p>
          </article>
        ))
      )}
    </section>
  );
}

function SearchPanel({
  bases,
  folderUid,
  gateway,
  knowledgeBaseId,
  openCitation,
}: {
  bases: KnowledgeBaseRecord[];
  folderUid: string;
  gateway: KnowledgeManagementGateway;
  knowledgeBaseId: string;
  openCitation: (citation: KnowledgeSearchHit['citation']) => void;
}) {
  const [query, setQuery] = useState('');
  const [service, setService] = useState('');
  const [tagsAny, setTagsAny] = useState('');
  const [tagsAll, setTagsAll] = useState('');
  const [knowledgeBaseIds, setKnowledgeBaseIds] = useState([knowledgeBaseId]);
  const [state, setState] = useState<Loadable<KnowledgeSearchHit[]> | undefined>();
  const requestRef = useRef(0);
  const searchAbortRef = useRef<AbortController>();
  useEffect(() => () => searchAbortRef.current?.abort(), []);
  const search = async (event: FormEvent) => {
    event.preventDefault();
    searchAbortRef.current?.abort();
    const controller = new AbortController();
    searchAbortRef.current = controller;
    const request = ++requestRef.current;
    setState({ status: 'loading' });
    try {
      const hits = await gateway.search(
        folderUid,
        {
          query,
          knowledgeBaseIds,
          service: service.trim() || undefined,
          tagsAny: splitTags(tagsAny),
          tagsAll: splitTags(tagsAll),
          limit: 10,
        },
        controller.signal
      );
      if (request === requestRef.current) {
        setState({ status: 'success', data: hits });
      }
    } catch (error) {
      if (request === requestRef.current && !isAbortError(error)) {
        setState({ status: 'error', error: toError(error) });
      }
    }
  };
  return (
    <section>
      <form className="knowledge-search-form" onSubmit={search}>
        <select
          aria-label="检索知识库"
          multiple
          onChange={(event) =>
            setKnowledgeBaseIds(Array.from(event.currentTarget.selectedOptions, (option) => option.value))
          }
          value={knowledgeBaseIds}
        >
          {bases.map((base) => (
            <option key={base.id} value={base.id}>
              {base.name}
            </option>
          ))}
        </select>
        <input
          aria-label="检索问题"
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="输入问题或关键词"
          required
          value={query}
        />
        <input aria-label="任一标签" onChange={(event) => setTagsAny(event.currentTarget.value)} placeholder="任一标签" value={tagsAny} />
        <input aria-label="全部标签" onChange={(event) => setTagsAll(event.currentTarget.value)} placeholder="全部标签" value={tagsAll} />
        <input
          aria-label="筛选服务"
          onChange={(event) => setService(event.currentTarget.value)}
          placeholder="服务筛选（可选）"
          value={service}
        />
        <button className="knowledge-button primary" type="submit">
          <Search size={13} /> 检索
        </button>
      </form>
      {state?.status === 'loading' && <State text="正在检索…" />}
      {state?.status === 'error' && <ErrorState error={state.error} retry={() => setState(undefined)} />}
      {state?.status === 'success' && (
        <div className="knowledge-search-results">
          {state.data.map((hit, index) => (
            <article key={`${hit.citation.document_id}:${hit.citation.ordinal}:${index}`}>
              <p>{hit.text}</p>
              <button className="knowledge-citation-link" onClick={() => openCitation(hit.citation)} type="button">
                {hit.citation.source_name} · {hit.citation.location || `段落 ${hit.citation.ordinal}`}
              </button>
            </article>
          ))}
          {state.data.length === 0 && <div className="knowledge-empty">没有检索结果。</div>}
        </div>
      )}
    </section>
  );
}

function State({ text }: { text: string }) {
  return <div className="knowledge-state">{text}</div>;
}
function ErrorState({ error, retry }: { error: Error; retry: () => void }) {
  return (
    <div className="knowledge-state error">
      <AlertCircle size={18} />
      <span>{error.message}</span>
      <button className="knowledge-button secondary" onClick={retry} type="button">
        <RefreshCw size={13} /> 重试
      </button>
    </div>
  );
}
function tabLabel(tab: Tab): string {
  return tab === 'documents' ? '文档' : '检索测试';
}
function splitTags(value: string): string[] {
  return value
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}
function formatSize(size: number): string {
  return size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`;
}
function operationKey(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
}
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Knowledge 请求失败。');
}
