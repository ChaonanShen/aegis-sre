import React, { FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Download, FileText, Plus, RefreshCw, Search, Trash2, Upload } from 'lucide-react';
import { useAppShell } from '../../app/AppShellContext';
import {
  KnowledgeBaseRecord,
  KnowledgeChunkRecord,
  KnowledgeDocumentRecord,
  KnowledgeSearchHit,
} from './managementModel';
import { KnowledgeManagementGateway } from './ports/KnowledgeManagementGateway';
import './knowledge.css';

type Loadable<T> = { status: 'loading' } | { status: 'error'; error: Error } | { status: 'success'; data: T };
type Tab = 'documents' | 'search' | 'runbooks';

export default function RealKnowledgePage({ gateway }: { gateway: KnowledgeManagementGateway }) {
  const { activeFolder } = useAppShell();
  const folderUid = activeFolder?.uid;
  const writable = activeFolder?.permission === 'Edit' || activeFolder?.permission === 'Admin';
  const [bases, setBases] = useState<Loadable<KnowledgeBaseRecord[]>>({ status: 'loading' });
  const [selectedBaseId, setSelectedBaseId] = useState<string>();
  const [documents, setDocuments] = useState<Loadable<KnowledgeDocumentRecord[]>>({ status: 'loading' });
  const [tab, setTab] = useState<Tab>('documents');
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [refreshBases, setRefreshBases] = useState(0);
  const [refreshDocuments, setRefreshDocuments] = useState(0);
  const selectedBase = bases.status === 'success' ? bases.data.find(({ id }) => id === selectedBaseId) : undefined;

  useEffect(() => {
    if (!folderUid) {
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
  }, [folderUid, gateway, refreshBases]);

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

  // RAGFlow 解析是异步过程，仅在存在进行中文档时轮询，离开 Folder/KB 立即取消。
  useEffect(() => {
    if (
      documents.status !== 'success' ||
      !documents.data.some(({ status }) => status === 'pending' || status === 'indexing')
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
    return <State text="当前没有可访问的 Grafana Folder。" />;
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
            <small>{base.status}</small>
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
        {!selectedBase ? (
          <State text="创建或选择一个知识库后开始管理文档。" />
        ) : (
          <>
            <header className="knowledge-page-header">
              <div>
                <h1>{selectedBase.name}</h1>
                <p>
                  Folder: {activeFolder?.title} · {selectedBase.status}
                </p>
              </div>
              {writable && (
                <KnowledgeBaseActions
                  base={selectedBase}
                  busy={busy}
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
              {(['documents', 'search', 'runbooks'] as Tab[]).map((item) => (
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
                refresh={() => setRefreshDocuments((value) => value + 1)}
                writable={writable}
              />
            )}
            {tab === 'search' && (
              <SearchPanel folderUid={folderUid} gateway={gateway} knowledgeBaseId={selectedBase.id} />
            )}
            {tab === 'runbooks' && (
              <div className="knowledge-empty">
                <strong>Runbook 尚未接入 Knowledge Provider</strong>
                <p>请前往 Playbooks 页面管理原生 Dagu YAML；这里不会显示 fixture 数据。</p>
              </div>
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
  folderUid,
  gateway,
  onMutate,
  refresh,
}: {
  base: KnowledgeBaseRecord;
  busy: boolean;
  folderUid: string;
  gateway: KnowledgeManagementGateway;
  onMutate: (operation: () => Promise<void>, success: string) => Promise<void>;
  refresh: () => void;
}) {
  const toggle = () =>
    onMutate(async () => {
      await gateway.updateKnowledgeBase(folderUid, base.id, {
        name: base.name,
        status: base.status === 'active' ? 'disabled' : 'active',
      });
      refresh();
    }, '知识库状态已更新。');
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
      <button className="knowledge-button secondary" disabled={busy} onClick={() => void toggle()} type="button">
        {base.status === 'active' ? '停用' : '启用'}
      </button>
      <button className="knowledge-button danger" disabled={busy} onClick={remove} type="button">
        <Trash2 size={13} /> 删除
      </button>
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
  refresh,
  writable,
}: {
  busy: boolean;
  documents: Loadable<KnowledgeDocumentRecord[]>;
  folderUid: string;
  gateway: KnowledgeManagementGateway;
  knowledgeBaseId: string;
  mutate: (operation: () => Promise<void>, success: string) => Promise<void>;
  refresh: () => void;
  writable: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [chunks, setChunks] = useState<{
    document: KnowledgeDocumentRecord;
    state: Loadable<KnowledgeChunkRecord[]>;
  }>();
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
  const showChunks = (document: KnowledgeDocumentRecord) => {
    setChunks({ document, state: { status: 'loading' } });
    void gateway
      .listChunks(folderUid, knowledgeBaseId, document.id)
      .then((data) => setChunks({ document, state: { status: 'success', data } }))
      .catch((error: unknown) => setChunks({ document, state: { status: 'error', error: toError(error) } }));
  };
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
            accept=".pdf,.docx,.md,.txt,.html"
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
              <button onClick={() => showChunks(document)} type="button">
                切片
              </button>
              <button aria-label={`下载 ${document.name}`} onClick={() => void download(document)} type="button">
                <Download size={13} />
              </button>
              {writable && (
                <DocumentWriteActions
                  busy={busy}
                  document={document}
                  folderUid={folderUid}
                  gateway={gateway}
                  knowledgeBaseId={knowledgeBaseId}
                  mutate={mutate}
                  refresh={refresh}
                />
              )}
            </div>
          </article>
        ))}
        {documents.data.length === 0 && (
          <div className="knowledge-empty">尚无文档。上传 PDF、DOCX、Markdown、TXT 或 HTML 文件开始构建索引。</div>
        )}
      </section>
      {chunks && <ChunksPanel close={() => setChunks(undefined)} document={chunks.document} state={chunks.state} />}
    </>
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
  const index = document.status === 'indexing' ? gateway.stopIndexing : gateway.startIndexing;
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
      <button
        disabled={busy}
        onClick={() =>
          void mutate(
            async () => {
              await index(folderUid, knowledgeBaseId, document.id);
              refresh();
            },
            document.status === 'indexing' ? '已请求停止解析。' : '已请求开始解析。'
          )
        }
        type="button"
      >
        {document.status === 'indexing' ? '停止' : '索引'}
      </button>
      <button aria-label={`删除 ${document.name}`} disabled={busy} onClick={remove} type="button">
        <Trash2 size={13} />
      </button>
    </>
  );
}

function ChunksPanel({
  close,
  document,
  state,
}: {
  close: () => void;
  document: KnowledgeDocumentRecord;
  state: Loadable<KnowledgeChunkRecord[]>;
}) {
  return (
    <section className="knowledge-chunks">
      <header>
        <strong>{document.name} 的切片</strong>
        <button onClick={close} type="button">
          关闭
        </button>
      </header>
      {state.status === 'loading' ? (
        <State text="正在加载切片…" />
      ) : state.status === 'error' ? (
        <ErrorState error={state.error} retry={close} />
      ) : (
        state.data.map((chunk) => (
          <article key={chunk.id}>
            <small>
              第 {chunk.page_number} 页 · {chunk.position}
            </small>
            <p>{chunk.text}</p>
          </article>
        ))
      )}
    </section>
  );
}

function SearchPanel({
  folderUid,
  gateway,
  knowledgeBaseId,
}: {
  folderUid: string;
  gateway: KnowledgeManagementGateway;
  knowledgeBaseId: string;
}) {
  const [query, setQuery] = useState('');
  const [service, setService] = useState('');
  const [state, setState] = useState<Loadable<KnowledgeSearchHit[]> | undefined>();
  const requestRef = useRef(0);
  const search = async (event: FormEvent) => {
    event.preventDefault();
    const request = ++requestRef.current;
    setState({ status: 'loading' });
    try {
      const hits = await gateway.search(folderUid, {
        query,
        knowledgeBaseIds: [knowledgeBaseId],
        service: service.trim() || undefined,
        limit: 10,
        threshold: 0.2,
      });
      if (request === requestRef.current) {
        setState({ status: 'success', data: hits });
      }
    } catch (error) {
      if (request === requestRef.current) {
        setState({ status: 'error', error: toError(error) });
      }
    }
  };
  return (
    <section>
      <form className="knowledge-search-form" onSubmit={search}>
        <input
          aria-label="检索问题"
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="输入问题或关键词"
          required
          value={query}
        />
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
            <article key={`${hit.citation.document_id}:${hit.citation.position}:${index}`}>
              <p>{hit.text}</p>
              <footer>
                {hit.citation.source_name} · 第 {hit.citation.page_number} 页 · {hit.citation.position} ·{' '}
                {(hit.score * 100).toFixed(1)}%
              </footer>
            </article>
          ))}
          {state.data.length === 0 && <div className="knowledge-empty">没有达到阈值的检索结果。</div>}
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
  return tab === 'documents' ? '文档' : tab === 'search' ? '检索测试' : 'Runbooks';
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
