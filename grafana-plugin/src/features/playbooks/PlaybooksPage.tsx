import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Plus, Search } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAppServices } from '../../app/AppServices';
import { ROUTES } from '../../constants';
import { prefixRoute } from '../../utils/utils.routing';
import { usePlaybooksController } from './application/usePlaybooksController';
import { PlaybookDag } from './components/PlaybookDag';
import { PlaybookEditor } from './components/PlaybookEditor';
import { PlaybookDocument, PlaybookSummary } from './crudModel';
import { projectDaguSource } from './daguSource';
import { PlaybookCrudGateway } from './ports/PlaybookCrudGateway';
import './playbooks.css';

export default function PlaybooksPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { playbookGateway } = useAppServices();
  const tail = location.pathname.split(`/${ROUTES.Playbooks}/`)[1] ?? '';
  const [resourceId, action] = tail.split('/');

  if (!resourceId) {
    return <PlaybookListRoute gateway={playbookGateway} />;
  }
  if (resourceId === 'new') {
    return <PlaybookEditor gateway={playbookGateway} onSaved={(saved) => navigate(prefixRoute(`${ROUTES.Playbooks}/${saved.id}`))} />;
  }
  return <PlaybookResourceRoute edit={action === 'edit'} gateway={playbookGateway} id={resourceId} key={`${resourceId}:${action}`} />;
}

function PlaybookListRoute({ gateway }: { gateway: PlaybookCrudGateway }) {
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
    />
  );
}

function PlaybookList({
  onOpen,
  playbooks,
  query,
  setQuery,
}: {
  onOpen: (id: string) => void;
  playbooks: PlaybookSummary[];
  query: string;
  setQuery: (value: string) => void;
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
        <button className="playbook-button primary" onClick={() => navigate(prefixRoute(`${ROUTES.Playbooks}/new`))} type="button">
          <Plus size={13} /> 新建 Playbook
        </button>
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

function PlaybookResourceRoute({ edit, gateway, id }: { edit: boolean; gateway: PlaybookCrudGateway; id: string }) {
  const navigate = useNavigate();
  const state = usePlaybook(gateway, id);
  if (state.status === 'loading') {
    return <div className="playbook-loading">正在加载 Playbook…</div>;
  }
  if (state.status === 'error') {
    return <LoadError error={state.error} retry={state.reload} />;
  }
  return edit ? (
    <PlaybookEditor gateway={gateway} onSaved={(saved) => navigate(prefixRoute(`${ROUTES.Playbooks}/${saved.id}`))} playbook={state.data} />
  ) : (
    <PlaybookDetail gateway={gateway} playbook={state.data} />
  );
}

function PlaybookDetail({ gateway, playbook }: { gateway: PlaybookCrudGateway; playbook: PlaybookDocument }) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<'dag' | 'yaml'>('dag');
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const projection = useMemo(() => projectDaguSource(playbook.source), [playbook.source]);
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
          <button className="playbook-button secondary" onClick={() => navigate(prefixRoute(`${ROUTES.Playbooks}/${playbook.id}/edit`))} type="button">编辑</button>
          <button className="playbook-button danger" disabled={deleting} onClick={() => void remove()} type="button">{deleting ? '删除中…' : '删除'}</button>
        </div>
      </header>
      {error && <div className="playbook-editor-error" role="alert">{error}</div>}
      <div className="playbook-tabs" role="tablist">
        <button aria-selected={tab === 'dag'} className={tab === 'dag' ? 'active' : ''} onClick={() => setTab('dag')} role="tab" type="button">DAG 可视化</button>
        <button aria-selected={tab === 'yaml'} className={tab === 'yaml' ? 'active' : ''} onClick={() => setTab('yaml')} role="tab" type="button">YAML 源码</button>
      </div>
      {tab === 'dag' ? <section className="playbook-panel"><PlaybookDag steps={projection.steps} /></section> : <section className="playbook-panel"><pre aria-label="Playbook YAML">{playbook.source}</pre></section>}
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
