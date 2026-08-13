import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { prefixRoute } from '../../../utils/utils.routing';
import { useDialogA11y } from '../../../utils/useDialogA11y';
import { ROUTES } from '../../../constants';
import { SessionSummary } from '../../workbench/model';
import { WorkbenchGateway } from '../../workbench/ports/WorkbenchGateway';
import { Playbook } from '../model';
import { PlaybookGateway } from '../ports/PlaybookGateway';

export function RevisionHistoryDialog({ onClose, playbook }: { onClose: () => void; playbook: Playbook }) {
  const dialogRef = useDialogA11y<HTMLElement>(onClose);
  return (
    <div className="playbook-modal-backdrop" role="presentation">
      <section
        aria-label={`${playbook.name} 版本历史`}
        aria-modal="true"
        className="playbook-modal"
        ref={dialogRef}
        role="dialog"
      >
        <header>
          <div>
            <h2>版本历史</h2>
            <p>{playbook.name}</p>
          </div>
          <button aria-label="关闭版本历史" onClick={onClose} type="button">
            ×
          </button>
        </header>
        <div className="playbook-revision-list">
          {playbook.revisions.map((revision) => (
            <article key={revision.revision}>
              <strong>
                r{revision.revision} · v{revision.displayVersion}
              </strong>
              <p>{revision.changeNote}</p>
              <small>
                {revision.author} · {new Date(revision.savedAt).toLocaleString('zh-CN')}
              </small>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

export function ConversationDraftDialog({
  onClose,
  playbookGateway,
  workbenchGateway,
}: {
  onClose: () => void;
  playbookGateway: PlaybookGateway;
  workbenchGateway: WorkbenchGateway;
}) {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [generating, setGenerating] = useState(false);
  const generatingRef = useRef(false);
  const generateRequestRef = useRef(0);
  const generateControllerRef = useRef<AbortController>();
  const requestRef = useRef(0);

  useEffect(() => {
    const request = ++requestRef.current;
    const controller = new AbortController();
    void workbenchGateway
      .listSessions(controller.signal)
      .then((result) => {
        if (request !== requestRef.current || controller.signal.aborted) {
          return;
        }
        const active = result.filter(({ status }) => status === 'active');
        setSessions(active);
        setSelected(active[0]?.id ?? '');
      })
      .catch((reason: unknown) => {
        if (request === requestRef.current && !controller.signal.aborted && !isAbortError(reason)) {
          setError(toError(reason).message);
        }
      });
    return () => {
      requestRef.current += 1;
      controller.abort();
    };
  }, [workbenchGateway]);

  useEffect(
    () => () => {
      generateRequestRef.current += 1;
      generateControllerRef.current?.abort();
    },
    []
  );

  const generate = async () => {
    const session = sessions.find(({ id }) => id === selected);
    if (!session || generatingRef.current) {
      return;
    }
    const request = ++generateRequestRef.current;
    const controller = new AbortController();
    generateControllerRef.current?.abort();
    generateControllerRef.current = controller;
    generatingRef.current = true;
    setGenerating(true);
    setError('');
    try {
      const draft = await playbookGateway.generateDraft({
        sessionId: session.id,
        sessionTitle: session.title,
        folderUid: session.folderUid,
      }, controller.signal);
      if (request === generateRequestRef.current && !controller.signal.aborted) {
        navigate(`${prefixRoute(`${ROUTES.Playbooks}/new`)}?draft=${draft.id}`);
      }
    } catch (reason) {
      if (request === generateRequestRef.current && !isAbortError(reason)) {
        setError(toError(reason).message);
      }
    } finally {
      if (request === generateRequestRef.current && generateControllerRef.current === controller) {
        generateControllerRef.current = undefined;
        generatingRef.current = false;
        setGenerating(false);
      }
    }
  };
  const close = () => {
    generateRequestRef.current += 1;
    generateControllerRef.current?.abort();
    generateControllerRef.current = undefined;
    generatingRef.current = false;
    setGenerating(false);
    onClose();
  };
  const dialogRef = useDialogA11y<HTMLElement>(close);

  return (
    <div className="playbook-modal-backdrop" role="presentation">
      <section
        aria-label="从对话沉淀 Playbook"
        aria-modal="true"
        className="playbook-modal"
        ref={dialogRef}
        role="dialog"
      >
        <header>
          <div>
            <h2>从对话沉淀</h2>
            <p>选择一个会话生成草稿，确认后再保存。</p>
          </div>
          <button aria-label="关闭对话沉淀" onClick={close} type="button">
            ×
          </button>
        </header>
        {error && <div className="playbook-editor-error">{error}</div>}
        <label>
          Workbench 会话
          <select aria-label="Workbench 会话" onChange={(event) => setSelected(event.currentTarget.value)} value={selected}>
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.title} · {session.folderTitle}
              </option>
            ))}
          </select>
        </label>
        <footer>
          <button className="playbook-button secondary" onClick={close} type="button">
            取消
          </button>
          <button
            className="playbook-button primary"
            disabled={!selected || generating}
            onClick={() => void generate()}
            type="button"
          >
            {generating ? '生成中…' : '生成草稿'}
          </button>
        </footer>
      </section>
    </div>
  );
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error('加载会话失败。');
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
