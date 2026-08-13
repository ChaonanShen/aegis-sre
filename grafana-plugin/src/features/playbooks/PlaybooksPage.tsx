import React, { useMemo, useState } from 'react';
import { AlertCircle, History, Play, Plus, Search, Sparkles } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAppServices } from '../../app/AppServices';
import { useAppShell } from '../../app/AppShellContext';
import { Folder } from '../../app/model';
import { prefixRoute } from '../../utils/utils.routing';
import { canEditVisibleResource } from '../../utils/resourcePermissions';
import { ROUTES } from '../../constants';
import { usePlaybooksController } from './application/usePlaybooksController';
import { ConversationDraftDialog, RevisionHistoryDialog } from './components/PlaybookDialogs';
import { PlaybookDag } from './components/PlaybookDag';
import { PlaybookEditor } from './components/PlaybookEditor';
import { PlaybookRunPanel } from './components/PlaybookRunPanel';
import { Playbook } from './model';
import { PlaybookGateway } from './ports/PlaybookGateway';
import { WorkbenchGateway } from '../workbench/ports/WorkbenchGateway';
import './playbooks.css';

export default function PlaybooksPage() {
  const location = useLocation();
  const routeTail = location.pathname.split(`/${ROUTES.Playbooks}/`)[1] ?? '';
  const { playbookGateway, workbenchGateway } = useAppServices();
  const { folders } = useAppShell();
  const folderList = useMemo(() => (folders.status === 'success' ? folders.data : []), [folders]);
  const controller = usePlaybooksController({ folders: folderList, gateway: playbookGateway });

  if (controller.state.status === 'loading') {
    return <div className="playbook-loading">正在加载 Playbooks…</div>;
  }
  if (controller.state.status === 'error') {
    return (
      <div className="playbook-error" role="alert">
        <AlertCircle size={16} />
        <span>{controller.state.error.message}</span>
        <button onClick={() => void controller.reload()} type="button">
          重试
        </button>
      </div>
    );
  }

  const [resourceId, action] = routeTail.split('/');
  if (resourceId === 'new') {
    const draftId = new URLSearchParams(location.search).get('draft') ?? undefined;
    return (
      <PlaybookEditor
        draftId={draftId}
        folders={folderList}
        gateway={playbookGateway}
        key={`new:${draftId ?? 'empty'}`}
        onSaved={controller.reload}
      />
    );
  }
  if (resourceId && action === 'edit') {
    const playbook = controller.state.data.find(({ id }) => id === resourceId);
    if (!playbook) {
      return (
        <PlaybookDetail
          folders={folderList}
          gateway={playbookGateway}
          key={`detail:${resourceId}`}
          onChanged={controller.reload}
          playbookId={resourceId}
          playbooks={controller.state.data}
        />
      );
    }
    const permission = playbook.folderUid ? folderList.find(({ uid }) => uid === playbook.folderUid)?.permission : undefined;
    if (!canEditVisibleResource(playbook.visibility, permission)) {
      return (
        <PlaybookDetail
          folders={folderList}
          gateway={playbookGateway}
          key={`detail:${playbook.id}`}
          onChanged={controller.reload}
          playbookId={playbook.id}
          playbooks={controller.state.data}
        />
      );
    }
    return (
      <PlaybookEditor
        folders={folderList}
        gateway={playbookGateway}
        key={`edit:${playbook.id}`}
        onSaved={controller.reload}
        playbook={playbook}
      />
    );
  }
  return resourceId ? (
    <PlaybookDetail
      folders={folderList}
      gateway={playbookGateway}
      key={`detail:${resourceId}`}
      onChanged={controller.reload}
      playbookId={resourceId}
      playbooks={controller.state.data}
    />
  ) : (
    <PlaybookList
      folders={folderList}
      foldersReady={folders.status === 'success'}
      playbookGateway={playbookGateway}
      playbooks={controller.state.data}
      workbenchGateway={workbenchGateway}
    />
  );
}

function PlaybookList({
  folders,
  foldersReady,
  playbookGateway,
  playbooks,
  workbenchGateway,
}: {
  folders: Folder[];
  foldersReady: boolean;
  playbookGateway: PlaybookGateway;
  playbooks: Playbook[];
  workbenchGateway: WorkbenchGateway;
}) {
  const navigate = useNavigate();
  const [draftDialogOpen, setDraftDialogOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [folderUid, setFolderUid] = useState('all');
  const [visibility, setVisibility] = useState('all');
  const effectiveFolderUid =
    foldersReady && folderUid !== 'all' && !folders.some(({ uid }) => uid === folderUid) ? 'all' : folderUid;
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return playbooks.filter(
      (playbook) =>
        (!normalized ||
          `${playbook.name} ${playbook.description} ${playbook.ownerId} ${playbook.trigger.pattern ?? ''}`
            .toLocaleLowerCase()
            .includes(normalized)) &&
        (effectiveFolderUid === 'all' || playbook.folderUid === effectiveFolderUid) &&
        (visibility === 'all' || playbook.visibility === visibility)
    );
  }, [effectiveFolderUid, playbooks, query, visibility]);

  return (
    <main className="playbooks-page">
      <header className="playbook-page-header">
        <div>
          <h1>Playbooks</h1>
          <p>编排并复用可重复执行的调查与处置流程。</p>
        </div>
        <div className="playbook-header-actions">
          <button className="playbook-button secondary" onClick={() => setDraftDialogOpen(true)} type="button">
            <Sparkles size={13} /> 从对话沉淀
          </button>
          <button
            className="playbook-button primary"
            onClick={() => navigate(prefixRoute(`${ROUTES.Playbooks}/new`))}
            type="button"
          >
            <Plus size={13} /> 新建 Playbook
          </button>
        </div>
      </header>

      <div className="playbook-toolbar">
        <label className="playbook-search">
          <Search aria-hidden size={15} />
          <span className="sr-only">搜索 Playbook</span>
          <input
            aria-label="搜索 Playbook"
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="搜索 playbook..."
            value={query}
          />
        </label>
        <label>
          <span className="sr-only">Folder 筛选</span>
          <select
            aria-label="Folder 筛选"
            onChange={(event) => setFolderUid(event.currentTarget.value)}
            value={effectiveFolderUid}
          >
            <option value="all">Folder: All</option>
            {folders.map((folder) => (
              <option key={folder.uid} value={folder.uid}>
                Folder: {folder.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="sr-only">Visibility 筛选</span>
          <select
            aria-label="Visibility 筛选"
            onChange={(event) => setVisibility(event.currentTarget.value)}
            value={visibility}
          >
            <option value="all">Visibility: All</option>
            <option value="shared">Visibility: shared</option>
            <option value="private">Visibility: private</option>
          </select>
        </label>
        <span className="playbook-toolbar-spacer" />
        <span className="playbook-count">{filtered.length} 个 playbook</span>
      </div>

      {filtered.length === 0 ? (
        <div className="playbook-empty">没有符合当前筛选条件的 Playbook。</div>
      ) : (
        <section aria-label="Playbook 列表" className="playbook-grid">
          {filtered.map((playbook) => (
            <button
              className="playbook-card"
              key={playbook.id}
              onClick={() => navigate(prefixRoute(`${ROUTES.Playbooks}/${playbook.id}`))}
              type="button"
            >
              <div className="playbook-card-heading">
                <strong>{playbook.name}</strong>
                <span className={`playbook-tag ${playbook.visibility}`}>{playbook.visibility}</span>
              </div>
              <p>{playbook.description}</p>
              <div className="playbook-card-meta">
                v{playbook.version} · trigger:{' '}
                {playbook.trigger.type === 'alert' ? `alert: ${playbook.trigger.pattern}` : 'manual'}
              </div>
              <div className="playbook-card-footer">
                <span className="playbook-tag runs">
                  <Play size={11} /> {playbook.usageCount} runs
                </span>
                {playbook.folderUid && <span className="playbook-tag">{playbook.folderUid}</span>}
                <span className="playbook-tag owner">owner: {playbook.ownerId}</span>
              </div>
            </button>
          ))}
        </section>
      )}
      {draftDialogOpen && (
        <ConversationDraftDialog
          onClose={() => setDraftDialogOpen(false)}
          playbookGateway={playbookGateway}
          workbenchGateway={workbenchGateway}
        />
      )}
    </main>
  );
}

function PlaybookDetail({
  folders,
  gateway,
  onChanged,
  playbookId,
  playbooks,
}: {
  folders: Folder[];
  gateway: PlaybookGateway;
  onChanged: () => Promise<void>;
  playbookId: string;
  playbooks: Playbook[];
}) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<'dag' | 'yaml' | 'run'>('dag');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [runSetupOpen, setRunSetupOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState('');
  const playbook = playbooks.find(({ id }) => id === playbookId);
  if (!playbook) {
    return (
      <main className="playbooks-page">
        <div className="playbook-empty">
          找不到这个 Playbook。
          <button onClick={() => navigate(prefixRoute(ROUTES.Playbooks))} type="button">
            返回列表
          </button>
        </div>
      </main>
    );
  }
  const permission = playbook.folderUid ? folders.find(({ uid }) => uid === playbook.folderUid)?.permission : undefined;
  const writable = canEditVisibleResource(playbook.visibility, permission);
  const remove = async () => {
    if (!writable || deleting || !window.confirm(`删除 Playbook "${playbook.name}"？相关运行记录也会被删除。`)) {
      return;
    }
    setDeleting(true);
    setActionError('');
    try {
      await gateway.deletePlaybook(playbook.id, playbook.recordVersion);
      await onChanged();
      navigate(prefixRoute(ROUTES.Playbooks));
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : '删除 Playbook 失败。');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <main className="playbooks-page">
      <header className="playbook-page-header">
        <div>
          <div className="playbook-breadcrumb">
            <button onClick={() => navigate(prefixRoute(ROUTES.Playbooks))} type="button">
              ← 返回
            </button>
            <span>/</span>
            <code>{playbook.name}</code>
            <span className="playbook-tag">v{playbook.version}</span>
            <span className={`playbook-tag ${playbook.visibility}`}>
              {playbook.visibility}
              {playbook.folderUid ? ` · ${playbook.folderUid}` : ''}
            </span>
          </div>
          <p>{playbook.description}</p>
        </div>
        <div className="playbook-header-actions">
          <button
            className="playbook-button secondary"
            disabled={!writable}
            onClick={() => navigate(prefixRoute(`${ROUTES.Playbooks}/${playbook.id}/edit`))}
            type="button"
          >
            编辑
          </button>
          <button className="playbook-button secondary" onClick={() => setHistoryOpen(true)} type="button">
            <History size={13} /> 经验 ({playbook.experience.length})
          </button>
          <button
            className="playbook-button primary"
            onClick={() => {
              setTab('run');
              setRunSetupOpen(true);
            }}
            type="button"
          >
            <Play size={13} /> 预览运行
          </button>
          <button
            className="playbook-button danger"
            disabled={!writable || deleting}
            onClick={() => void remove()}
            type="button"
          >
            {deleting ? '删除中…' : '删除'}
          </button>
        </div>
      </header>
      {actionError && (
        <div className="playbook-editor-error" role="alert">
          {actionError}
        </div>
      )}

      <div className="playbook-tabs">
        {(['dag', 'yaml', 'run'] as const).map((value) => (
          <button
            aria-selected={tab === value}
            className={tab === value ? 'active' : ''}
            key={value}
            onClick={() => setTab(value)}
            role="tab"
            type="button"
          >
            {value === 'dag' ? 'DAG 可视化' : value === 'yaml' ? 'YAML 源码' : '执行结果'}
          </button>
        ))}
        <span />
        <small>
          trigger: <code>{playbook.trigger.type}</code> · owner: {playbook.ownerId} · {playbook.usageCount} runs
        </small>
      </div>

      {tab === 'dag' && (
        <section className="playbook-panel">
          <PlaybookDag steps={playbook.steps} />
        </section>
      )}
      {tab === 'yaml' && (
        <section className="playbook-panel">
          <pre aria-label="Playbook YAML">{toPlaybookYaml(playbook)}</pre>
        </section>
      )}
      {tab === 'run' && (
        <PlaybookRunPanel
          canApprove={writable}
          gateway={gateway}
          key={playbook.id}
          onSetupClose={() => setRunSetupOpen(false)}
          playbook={playbook}
          setupOpen={runSetupOpen}
        />
      )}

      <section className="playbook-panel playbook-experience">
        <h2>修订记录</h2>
        <p>记录每次修改的原因和作者，便于审核与追溯。</p>
        {playbook.experience.length === 0 ? (
          <div className="playbook-empty compact">还没有经验记录。</div>
        ) : (
          playbook.experience.map((note) => (
            <article key={`${note.date}-${note.author}`}>
              <History aria-hidden size={13} />
              <div>
                <strong>{note.body}</strong>
                <small>
                  {note.author} · {new Date(note.date).toLocaleDateString('zh-CN')}
                </small>
              </div>
            </article>
          ))
        )}
      </section>
      {historyOpen && <RevisionHistoryDialog onClose={() => setHistoryOpen(false)} playbook={playbook} />}
    </main>
  );
}

function toPlaybookYaml(playbook: Playbook): string {
  const lines = [
    `id: ${playbook.id}`,
    `name: ${playbook.name}`,
    `description: ${JSON.stringify(playbook.description)}`,
    `version: "${playbook.version}"`,
    'trigger:',
    `  type: ${playbook.trigger.type}`,
  ];
  if (playbook.trigger.pattern) {
    lines.push(`  pattern: ${JSON.stringify(playbook.trigger.pattern)}`);
  }
  lines.push('parameters:');
  if (playbook.parameters.length === 0) {
    lines.push('  []');
  } else {
    playbook.parameters.forEach((parameter) => {
      lines.push(`  - name: ${parameter.name}`, `    type: ${parameter.type}`);
      if (parameter.defaultValue) {
        lines.push(`    default: ${JSON.stringify(parameter.defaultValue)}`);
      }
      lines.push(`    required: ${parameter.required}`);
    });
  }
  lines.push('steps:');
  playbook.steps.forEach((step) => {
    lines.push(`  - id: ${step.id}`, `    type: ${step.type}`, `    label: ${JSON.stringify(step.label)}`);
    if (step.dependsOn.length) {
      lines.push(`    depends_on: [${step.dependsOn.join(', ')}]`);
    }
    lines.push(`    config: ${JSON.stringify(step.config)}`);
    if (step.sideEffect) {
      lines.push('    side_effect: true', '    dry_run: true');
    }
  });
  return lines.join('\n');
}
