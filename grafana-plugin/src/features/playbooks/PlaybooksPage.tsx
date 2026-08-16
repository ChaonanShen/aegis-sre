import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Plus, Search } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAppServices } from '../../app/AppServices';
import { useAppShell } from '../../app/AppShellContext';
import { ROUTES } from '../../constants';
import { prefixRoute } from '../../utils/utils.routing';
import { usePlaybooksController } from './application/usePlaybooksController';
import { PlaybookDag } from './components/PlaybookDag';
import { PlaybookEditor } from './components/PlaybookEditor';
import { PlaybookRunsPanel } from './components/PlaybookRunsPanel';
import { PlaybookDocument, PlaybookSummary } from './crudModel';
import { projectDaguSource } from './daguSource';
import { PlaybookCrudGateway } from './ports/PlaybookCrudGateway';
import './playbooks.css';

export default function PlaybooksPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { playbookGateway, runtimeMode } = useAppServices();
  const { activeFolder } = useAppShell();
  const gateway = useMemo(
    () =>
      activeFolder && playbookGateway.withFolder
        ? playbookGateway.withFolder(activeFolder.uid)
        : runtimeMode === 'fixture'
          ? playbookGateway
          : undefined,
    [activeFolder, playbookGateway, runtimeMode]
  );
  const tail = location.pathname.split(`/${ROUTES.Playbooks}/`)[1] ?? '';
  const [resourceId, action] = tail.split('/');
  const writable = activeFolder?.permission === 'Edit' || activeFolder?.permission === 'Admin';
  const admin = activeFolder?.permission === 'Admin';

  if (!gateway) {
    return <div className="playbook-loading">请先在 Grafana 创建 Folder，或联系管理员授予 Folder 权限。</div>;
  }
  if (!resourceId) {
    return <PlaybookListRoute gateway={gateway} writable={runtimeMode === 'fixture' || writable} />;
  }
  if (resourceId === 'new') {
    if (runtimeMode !== 'fixture' && !writable) {
      return <div className="playbook-loading">当前 Folder 只有查看权限。</div>;
    }
    return <PlaybookEditor gateway={gateway} onSaved={(saved) => navigate(prefixRoute(`${ROUTES.Playbooks}/${saved.id}`))} />;
  }
  return <PlaybookResourceRoute admin={runtimeMode === 'fixture' || admin} edit={action === 'edit'} gateway={gateway} id={resourceId} key={`${activeFolder?.uid}:${resourceId}:${action}`} writable={runtimeMode === 'fixture' || writable} />;
}

function PlaybookListRoute({ gateway, writable }: { gateway: PlaybookCrudGateway; writable: boolean }) {
  const navigate = useNavigate();
  const controller = usePlaybooksController({ gateway });
  const [query, setQuery] = useState('');
  if (controller.state.status === 'loading') {
    return <div className="playbook-loading">正在加载 Playbooks…</div>;
  }
  if (controller.state.status === 'error') {
    return <LoadError error={controller.state.error} retry={() => void controller.reload()} />;
  }
  return (
    <PlaybookList
      onOpen={(id) => navigate(prefixRoute(`${ROUTES.Playbooks}/${id}`))}
      playbooks={controller.state.data}
      query={query}
      setQuery={setQuery}
      writable={writable}
    />
  );
}

function PlaybookList({
  onOpen,
  playbooks,
  query,
  setQuery,
  writable,
}: {
  onOpen: (id: string) => void;
  playbooks: PlaybookSummary[];
  query: string;
  setQuery: (value: string) => void;
  writable: boolean;
}) {
  const navigate = useNavigate();
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return playbooks.filter(({ name, description }) => `${name} ${description}`.toLocaleLowerCase().includes(normalized));
  }, [playbooks, query]);
  return (
    <main className="playbooks-page">
      <header className="playbook-page-header">
        <div><h1>Playbooks</h1><p>使用原生 Dagu YAML 管理可重复执行的流程定义。</p></div>
        {writable && (
          <button className="playbook-button primary" onClick={() => navigate(prefixRoute(`${ROUTES.Playbooks}/new`))} type="button">
            <Plus size={13} /> 新建 Playbook
          </button>
        )}
      </header>
      <div className="playbook-toolbar">
        <label className="playbook-search">
          <Search aria-hidden size={15} /><span className="sr-only">搜索 Playbook</span>
          <input aria-label="搜索 Playbook" onChange={(event) => setQuery(event.currentTarget.value)} placeholder="搜索 playbook..." value={query} />
        </label>
        <span className="playbook-toolbar-spacer" /><span className="playbook-count">{filtered.length} 个 playbook</span>
      </div>
      {filtered.length === 0 ? <div className="playbook-empty">没有符合当前筛选条件的 Playbook。</div> : (
        <section aria-label="Playbook 列表" className="playbook-grid">
          {filtered.map((playbook) => (
            <button className="playbook-card" key={playbook.id} onClick={() => onOpen(playbook.id)} type="button">
              <div className="playbook-card-heading"><strong>{playbook.name}</strong><span className="playbook-tag">{playbook.status}</span></div>
              <p>{playbook.description}</p>
            </button>
          ))}
        </section>
      )}
    </main>
  );
}

function PlaybookResourceRoute({ admin, edit, gateway, id, writable }: { admin: boolean; edit: boolean; gateway: PlaybookCrudGateway; id: string; writable: boolean }) {
  const navigate = useNavigate();
  const state = usePlaybook(gateway, id);
  if (state.status === 'loading') {
    return <div className="playbook-loading">正在加载 Playbook…</div>;
  }
  if (state.status === 'error') {
    return <LoadError error={state.error} retry={state.reload} />;
  }
  if (edit && !writable) {
    return <div className="playbook-loading">当前 Folder 只有查看权限。</div>;
  }
  return edit ? (
    <PlaybookEditor gateway={gateway} onSaved={(saved) => navigate(prefixRoute(`${ROUTES.Playbooks}/${saved.id}`))} playbook={state.data} />
  ) : (
    <PlaybookDetail admin={admin} gateway={gateway} playbook={state.data} writable={writable} />
  );
}

function PlaybookDetail({ admin, gateway, playbook, writable }: { admin: boolean; gateway: PlaybookCrudGateway; playbook: PlaybookDocument; writable: boolean }) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<'dag' | 'yaml' | 'runs'>('dag');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const projection = useMemo(() => {
    try {
      return projectDaguSource(playbook.source);
    } catch {
      return undefined;
    }
  }, [playbook.source]);
  const remove = async () => {
    if (deleting || !window.confirm(`删除 Playbook “${playbook.name}” 的定义？已有运行记录不会在此操作中删除。`)) {
      return;
    }
    setDeleting(true);
    setError('');
    try {
      await gateway.deletePlaybook(playbook.id);
      navigate(prefixRoute(ROUTES.Playbooks));
    } catch (reason) {
      setError(toError(reason).message);
      setDeleting(false);
    }
  };
  return (
    <main className="playbooks-page">
      <header className="playbook-page-header">
        <div>
          <div className="playbook-breadcrumb"><button onClick={() => navigate(prefixRoute(ROUTES.Playbooks))} type="button">← 返回</button><span>/</span><code>{playbook.name}</code><span className="playbook-tag">{playbook.status}</span></div>
          <p>{playbook.description}</p>
        </div>
        <div className="playbook-header-actions">
          {writable && <button className="playbook-button secondary" onClick={() => navigate(prefixRoute(`${ROUTES.Playbooks}/${playbook.id}/edit`))} type="button">编辑</button>}
          {admin && <button className="playbook-button danger" disabled={deleting} onClick={() => void remove()} type="button">{deleting ? '删除中…' : '删除'}</button>}
        </div>
      </header>
      {error && <div className="playbook-editor-error" role="alert">{error}</div>}
      <div className="playbook-tabs" role="tablist">
        <button aria-selected={tab === 'dag'} className={tab === 'dag' ? 'active' : ''} onClick={() => setTab('dag')} role="tab" type="button">DAG 可视化</button>
        <button aria-selected={tab === 'yaml'} className={tab === 'yaml' ? 'active' : ''} onClick={() => setTab('yaml')} role="tab" type="button">YAML 源码</button>
        <button aria-selected={tab === 'runs'} className={tab === 'runs' ? 'active' : ''} onClick={() => setTab('runs')} role="tab" type="button">运行记录</button>
      </div>
      {tab === 'dag' && <section className="playbook-panel">{projection ? <PlaybookDag steps={projection.steps} /> : <div className="playbook-empty compact">当前 YAML 无法生成简化 DAG 预览，请查看原生源码。</div>}</section>}
      {tab === 'yaml' && <section className="playbook-panel"><pre aria-label="Playbook YAML">{playbook.source}</pre></section>}
      {tab === 'runs' && <PlaybookRunsPanel admin={admin} gateway={gateway} playbookId={playbook.id} parameters={projection?.parameters} writable={writable} />}
    </main>
  );
}

type ResourceState =
  | { status: 'loading' }
  | { status: 'success'; data: PlaybookDocument }
  | { status: 'error'; error: Error; reload: () => void };

function usePlaybook(gateway: PlaybookCrudGateway, id: string): ResourceState {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ResourceState>({ status: 'loading' });
  const requestRef = useRef(0);
  useEffect(() => {
    const request = ++requestRef.current;
    const controller = new AbortController();
    void gateway.getPlaybook(id, controller.signal).then(
      (data) => { if (request === requestRef.current) { setState({ status: 'success', data }); } },
      (reason) => {
        if (request === requestRef.current && !isAbortError(reason)) {
          setState({
            status: 'error',
            error: toError(reason),
            reload: () => {
              setState({ status: 'loading' });
              setAttempt((value) => value + 1);
            },
          });
        }
      }
    );
    return () => { requestRef.current += 1; controller.abort(); };
  }, [attempt, gateway, id]);
  return state;
}

function LoadError({ error, retry }: { error: Error; retry: () => void }) {
  return <div className="playbook-error" role="alert"><AlertCircle size={16} /><span>{error.message}</span><button onClick={retry} type="button">重试</button></div>;
}

function toError(error: unknown): Error { return error instanceof Error ? error : new Error('Playbook 加载失败。'); }
function isAbortError(error: unknown): boolean { return error instanceof DOMException && error.name === 'AbortError'; }
