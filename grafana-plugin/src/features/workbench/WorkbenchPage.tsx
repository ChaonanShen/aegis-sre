import React, { CSSProperties, FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, LayoutGrid, Plus, X } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAppServices } from '../../app/AppServices';
import { useAppShell } from '../../app/AppShellContext';
import { workbenchRoute } from '../../utils/utils.routing';
import { useDialogA11y } from '../../utils/useDialogA11y';
import { useWorkbenchController } from './application/useWorkbenchController';
import { CanvasStrip } from './components/CanvasStrip';
import { ChatPane } from './components/ChatPane';
import { ContextPane } from './components/ContextPane';
import { DeleteSessionModal } from './components/DeleteSessionModal';
import { HITLModal } from './components/HITLModal';
import { SessionHistoryPane } from './components/SessionHistoryPane';
import { SplitHandle } from './components/SplitHandle';
import './workbench.css';

const SPLIT_LAYOUT_STORAGE_KEY = 'torchbearing.workbench.split-layout.v1';
const DEFAULT_HISTORY_WIDTH = 270;
const MIN_HISTORY_WIDTH = 220;
const MAX_HISTORY_WIDTH = 320;
const DEFAULT_CONVERSATION_WIDTH = 400;
const MIN_CONVERSATION_WIDTH = 320;
const MAX_CONVERSATION_WIDTH = 480;

interface SplitLayout {
  historyWidth: number;
  conversationWidth: number;
}

type SplitLayoutStyle = CSSProperties & {
  '--history-pane-width': string;
  '--conversation-pane-width': string;
};

export default function WorkbenchPage() {
  const { runtimeMode, workbenchGateway } = useAppServices();
  const { activeFolder, setActiveFolder } = useAppShell();
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId?: string }>();
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [newSessionTitle, setNewSessionTitle] = useState('');
  const [historyOpen, setHistoryOpen] = useState(true);
  const [contextOpen, setContextOpen] = useState(false);
  const [splitLayout, setSplitLayout] = useState(readSplitLayout);
  const [resizing, setResizing] = useState(false);
  const latestSplitLayout = useRef(splitLayout);
  const pageRef = useRef<HTMLElement>(null);
  const previousCompactLayout = useRef<boolean>();
  const onNavigate = useCallback(
    (id?: string, replace = false) => navigate(workbenchRoute(id), { replace }),
    [navigate]
  );
  const controller = useWorkbenchController({
    gateway: workbenchGateway,
    sessionId,
    activeFolder,
    onNavigate,
    onFolderChange: setActiveFolder,
  });
  const opened = controller.openedSession.status === 'success' ? controller.openedSession.data : undefined;
  const context = controller.context.status === 'success' ? controller.context.data : undefined;
  const creating = controller.creating.status === 'loading';
  const closeCreateModal = useCallback(() => {
    if (!creating) {
      setCreateModalOpen(false);
    }
  }, [creating]);
  const createDialogRef = useDialogA11y<HTMLElement>(closeCreateModal, { enabled: createModalOpen });

  useEffect(() => {
    const page = pageRef.current;
    if (!page || typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(([entry]) => {
      const compact = entry.contentRect.width <= 900;
      if (previousCompactLayout.current === undefined || previousCompactLayout.current !== compact) {
        setHistoryOpen(!compact);
        previousCompactLayout.current = compact;
      }
    });
    observer.observe(page);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!contextOpen) {
      return;
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setContextOpen(false);
      }
    };
    // Grafana 自身也会处理 Escape；捕获阶段先关闭插件抽屉，避免宿主快捷键截断事件。
    window.addEventListener('keydown', closeOnEscape, true);
    return () => window.removeEventListener('keydown', closeOnEscape, true);
  }, [contextOpen]);

  useEffect(() => {
    latestSplitLayout.current = splitLayout;
    const timeout = window.setTimeout(() => persistSplitLayout(splitLayout), 150);
    return () => window.clearTimeout(timeout);
  }, [splitLayout]);

  useEffect(
    () => () => {
      persistSplitLayout(latestSplitLayout.current);
    },
    []
  );

  const openCreateModal = () => {
    controller.resetCreate();
    setNewSessionTitle('');
    setCreateModalOpen(true);
  };

  const submitCreate = (event: FormEvent) => {
    event.preventDefault();
    if (creating || !newSessionTitle.trim()) {
      return;
    }
    void controller.createSession(newSessionTitle.trim()).then((created) => {
      if (created) {
        setCreateModalOpen(false);
      }
    });
  };

  const openDeleteModal = () => {
    controller.resetDelete();
    setDeleteModalOpen(true);
  };

  const splitStyle: SplitLayoutStyle = {
    '--history-pane-width': `${splitLayout.historyWidth}px`,
    '--conversation-pane-width': `${splitLayout.conversationWidth}px`,
  };

  return (
    <main className="workbench-page" data-testid="workbench-page" ref={pageRef}>
      <div
        className={`workbench-shell${historyOpen ? ' history-open' : ' history-closed'}${resizing ? ' is-resizing' : ''}`}
        style={splitStyle}
      >
        {historyOpen && (
          <>
            <SessionHistoryPane
              activeSessionId={sessionId}
              creating={creating}
              onClose={() => setHistoryOpen(false)}
              onCreate={openCreateModal}
              onOpen={(id) => onNavigate(id)}
              onRetry={() => void controller.retrySessions()}
              sessions={controller.sessions}
            />
            <SplitHandle
              ariaLabel="调整会话历史宽度"
              className="history-split-handle"
              controlledId="workbench-history-pane"
              defaultValue={DEFAULT_HISTORY_WIDTH}
              max={MAX_HISTORY_WIDTH}
              min={MIN_HISTORY_WIDTH}
              onChange={(historyWidth) => setSplitLayout((current) => ({ ...current, historyWidth }))}
              onCommit={(historyWidth) => persistSplitLayout({ ...latestSplitLayout.current, historyWidth })}
              onDraggingChange={setResizing}
              pointerDirection={1}
              value={splitLayout.historyWidth}
            />
          </>
        )}
        <section aria-label="会话工作区" className="workbench-center">
          {controller.openedSession.status === 'idle' &&
            (controller.sessions.status === 'success' && controller.sessions.data.length === 0 ? (
              <div className="workbench-state">
                <strong>还没有会话</strong>
                <span>新建一个会话，开始查询和整理可观测性数据。</span>
                <button className="btn btn-primary" onClick={openCreateModal} type="button">
                  <Plus aria-hidden size={13} /> 新建会话
                </button>
              </div>
            ) : (
              <div className="workbench-state">正在选择会话…</div>
            ))}
          {controller.openedSession.status === 'loading' && <div className="workbench-state">正在打开会话…</div>}
          {controller.openedSession.status === 'error' && (
            <div className="workbench-state error">
              <AlertCircle aria-hidden size={24} />
              <strong>会话打开失败</strong>
              <span>{controller.openedSession.error.message}</span>
              <button className="btn btn-secondary" onClick={controller.retryOpenedSession} type="button">
                重试
              </button>
            </div>
          )}
          {opened && (
            <>
              <div className="canvas-column">
                {!opened.canvas.visible && (
                  <button
                    className="canvas-restore"
                    onClick={() => controller.updateCanvas((canvas) => ({ ...canvas, visible: true }))}
                    type="button"
                  >
                    <LayoutGrid aria-hidden size={14} /> 重新打开画布
                  </button>
                )}
                <CanvasStrip
                  canvas={opened.canvas}
                  editingEnabled={runtimeMode === 'fixture'}
                  onChange={(canvas) => controller.updateCanvas(() => canvas)}
                  key={opened.session.id}
                />
              </div>
              <SplitHandle
                ariaLabel="调整对话宽度"
                className="content-split-handle"
                controlledId="workbench-conversation-pane"
                defaultValue={DEFAULT_CONVERSATION_WIDTH}
                max={MAX_CONVERSATION_WIDTH}
                min={MIN_CONVERSATION_WIDTH}
                onChange={(conversationWidth) => setSplitLayout((current) => ({ ...current, conversationWidth }))}
                onCommit={(conversationWidth) =>
                  persistSplitLayout({ ...latestSplitLayout.current, conversationWidth })
                }
                onDraggingChange={setResizing}
                pointerDirection={-1}
                value={splitLayout.conversationWidth}
              />
              <div className="conversation-column" id="workbench-conversation-pane">
                {controller.archiveError && (
                  <div className="form-error" role="alert">
                    {controller.archiveError}
                    <button onClick={controller.resetArchiveError} type="button">
                      关闭
                    </button>
                  </div>
                )}
                {controller.pendingHITL && !controller.hitlVisible && (
                  <button className="hitl-resume-banner" onClick={controller.showHITL} type="button">
                    有一项写操作等待审批 · 继续审批
                  </button>
                )}
                {controller.lastFailedInput && (
                  <button
                    className="stream-retry-banner"
                    onClick={() => void controller.retryLastMessage()}
                    type="button"
                  >
                    上次输出失败 · 点击重试
                  </button>
                )}
                <ChatPane
                  activeFolder={activeFolder}
                  attachmentsEnabled={runtimeMode === 'fixture'}
                  blockedByHITL={controller.pendingHITL !== null}
                  context={context}
                  contextOpen={contextOpen}
                  historyOpen={historyOpen}
                  onArchive={() => void controller.archiveCurrentSession()}
                  onRename={(title) => void controller.renameCurrentSession(title)}
                  onDelete={openDeleteModal}
                  onSend={(value, attachments) => void controller.sendMessage(value, attachments)}
                  onStop={controller.stopStreaming}
                  onToggleContext={() => setContextOpen((open) => !open)}
                  onToggleHistory={() => setHistoryOpen((open) => !open)}
                  opened={opened}
                  streaming={controller.streaming}
                />
              </div>
            </>
          )}
        </section>
        {contextOpen && (
          <ContextPane
            context={controller.context}
            onClose={() => setContextOpen(false)}
            onRetry={controller.retryContext}
          />
        )}
      </div>

      {createModalOpen && (
        <div className="workbench-modal-backdrop" role="presentation">
          <section
            aria-label="新建会话"
            aria-modal="true"
            className="create-session-modal"
            ref={createDialogRef}
            role="dialog"
          >
            <header>
              <strong>新建会话</strong>
              <button
                aria-label="关闭新建会话"
                className="icon-button"
                disabled={creating}
                onClick={closeCreateModal}
                type="button"
              >
                <X aria-hidden size={16} />
              </button>
            </header>
            <form onSubmit={submitCreate}>
              <label>
                <span>会话标题</span>
                <input
                  aria-label="会话标题"
                  autoFocus
                  disabled={creating}
                  onChange={(event) => setNewSessionTitle(event.currentTarget.value)}
                  placeholder="例如：Checkout 延迟排查"
                  value={newSessionTitle}
                />
                {runtimeMode === 'fixture' && activeFolder ? (
                  <small>会话将使用当前 Folder：{activeFolder.title}</small>
                ) : (
                  <small>会话创建后暂不绑定 Folder。</small>
                )}
              </label>
              {controller.creating.status === 'error' && (
                <div className="form-error">{controller.creating.error.message}</div>
              )}
              <footer>
                <button className="btn btn-secondary" disabled={creating} onClick={closeCreateModal} type="button">
                  取消
                </button>
                <button className="btn btn-primary" disabled={creating || !newSessionTitle.trim()} type="submit">
                  <Plus aria-hidden size={13} />
                  {creating ? '创建中…' : '创建'}
                </button>
              </footer>
            </form>
          </section>
        </div>
      )}

      <DeleteSessionModal
        deleting={controller.deleting.status === 'loading'}
        disabled={controller.streaming}
        error={controller.deleting.status === 'error' ? controller.deleting.error.message : undefined}
        onClose={() => setDeleteModalOpen(false)}
        onConfirm={() => {
          void controller.deleteCurrentSession().then((deleted) => {
            if (deleted) {
              setDeleteModalOpen(false);
            }
          });
        }}
        open={deleteModalOpen}
        sessionTitle={opened?.session.title ?? ''}
      />

      <HITLModal
        folder={activeFolder?.uid === controller.pendingHITLFolderUid ? activeFolder : undefined}
        key={controller.pendingHITL?.id ?? 'no-pending-hitl'}
        onApprove={(comment) => void controller.resolveHITL('approved', comment)}
        onClose={controller.hideHITL}
        onReject={(reason) => void controller.resolveHITL('rejected', reason)}
        open={controller.hitlVisible}
        request={controller.pendingHITL}
      />
    </main>
  );
}

function readSplitLayout(): SplitLayout {
  const fallback = { historyWidth: DEFAULT_HISTORY_WIDTH, conversationWidth: DEFAULT_CONVERSATION_WIDTH };
  try {
    const stored = JSON.parse(window.localStorage.getItem(SPLIT_LAYOUT_STORAGE_KEY) ?? 'null') as Partial<SplitLayout>;
    if (!stored || typeof stored !== 'object') {
      return fallback;
    }
    return {
      historyWidth: boundedWidth(stored.historyWidth, MIN_HISTORY_WIDTH, MAX_HISTORY_WIDTH, DEFAULT_HISTORY_WIDTH),
      conversationWidth: boundedWidth(
        stored.conversationWidth,
        MIN_CONVERSATION_WIDTH,
        MAX_CONVERSATION_WIDTH,
        DEFAULT_CONVERSATION_WIDTH
      ),
    };
  } catch {
    return fallback;
  }
}

function persistSplitLayout(layout: SplitLayout) {
  try {
    window.localStorage.setItem(SPLIT_LAYOUT_STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // The page remains usable when browser storage is unavailable.
  }
}

function boundedWidth(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;
}
