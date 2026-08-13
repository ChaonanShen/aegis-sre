import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Check, Clock, Eye, Filter, Folder, GitBranch, MessageSquare, Wand2, X } from 'lucide-react';
import { useAppServices } from '../../app/AppServices';
import { useAppShell } from '../../app/AppShellContext';
import { useDialogA11y } from '../../utils/useDialogA11y';
import { Approval, ApprovalObjectType, ApprovalQuery, ApprovalStatus, ApprovalSummary } from './model';
import './approvals.css';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'success'; approvals: Approval[]; summary: ApprovalSummary };

export default function ApprovalsPage() {
  const { approvalGateway } = useAppServices();
  const { folders } = useAppShell();
  const [query, setQuery] = useState<ApprovalQuery>({ status: 'pending' });
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [preview, setPreview] = useState<Approval>();
  const [rejecting, setRejecting] = useState<Approval>();
  const [rejectReason, setRejectReason] = useState('');
  const [actionError, setActionError] = useState('');
  const [busyId, setBusyId] = useState('');
  const requestVersion = useRef(0);
  const queryRef = useRef(query);
  const actionInFlightRef = useRef<string>();
  const actionControllerRef = useRef<AbortController>();
  const effectiveTargetFolderUid =
    folders.status === 'success' &&
    query.targetFolderUid &&
    !folders.data.some(({ uid }) => uid === query.targetFolderUid)
      ? undefined
      : query.targetFolderUid;
  const effectiveQuery = useMemo(
    () =>
      effectiveTargetFolderUid === query.targetFolderUid
        ? query
        : { ...query, targetFolderUid: effectiveTargetFolderUid },
    [effectiveTargetFolderUid, query]
  );
  const rejectDialogRef = useDialogA11y<HTMLFormElement>(() => setRejecting(undefined), {
    enabled: Boolean(rejecting),
  });

  useEffect(() => {
    queryRef.current = effectiveQuery;
  }, [effectiveQuery]);

  // A preview or rejection form belongs to the filter scope that opened it.
  // Close it when the scope changes so a user cannot submit an item from the
  // previous Folder/status view, and discard its transient error text.
  // This is an intentional navigation-scope reset, not derived rendering
  // state: the old dialog must close before the replacement request resolves.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setPreview(undefined);
    setRejecting(undefined);
    setRejectReason('');
    setActionError('');
  }, [effectiveQuery]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(
    () => () => {
      requestVersion.current += 1;
      actionControllerRef.current?.abort();
      actionInFlightRef.current = undefined;
    },
    []
  );

  const load = useCallback(
    (nextQuery: ApprovalQuery, signal?: AbortSignal) => {
      const currentRequest = ++requestVersion.current;
      setState({ status: 'loading' });
      return approvalGateway
        .listApprovals(nextQuery, signal)
        .then(({ approvals, summary }) => {
          if (currentRequest === requestVersion.current) {
            setState({ status: 'success', approvals, summary });
          }
        })
        .catch((error: unknown) => {
          if (
            currentRequest === requestVersion.current &&
            !(error instanceof DOMException && error.name === 'AbortError')
          ) {
            setState({ status: 'error', message: error instanceof Error ? error.message : '审批加载失败。' });
          }
        });
    },
    [approvalGateway]
  );

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(effectiveQuery, controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      requestVersion.current += 1;
    };
  }, [effectiveQuery, load]);

  const permissionByFolder = useMemo(
    () =>
      folders.status === 'success'
        ? Object.fromEntries(folders.data.map(({ uid, permission }) => [uid, permission]))
        : {},
    [folders]
  );

  const decide = async (approval: Approval, reason?: string) => {
    const admin = permissionByFolder[approval.targetFolderUid] === 'Admin';
    if (!admin || actionInFlightRef.current) {
      return;
    }
    if (reason !== undefined && !reason.trim()) {
      setActionError('请填写拒绝原因。');
      return;
    }
    actionInFlightRef.current = approval.id;
    const controller = new AbortController();
    actionControllerRef.current = controller;
    setBusyId(approval.id);
    setActionError('');
    try {
      if (reason === undefined) {
        if (!window.confirm(`批准 "${approval.objectTitle}" 晋升到 ${approval.targetFolderTitle}？`)) {
          return;
        }
        await approvalGateway.approve({ id: approval.id, expectedVersion: approval.recordVersion }, controller.signal);
      } else {
        await approvalGateway.reject(
          { id: approval.id, expectedVersion: approval.recordVersion, reason: reason.trim() },
          controller.signal
        );
        setRejecting(undefined);
        setRejectReason('');
      }
      if (!controller.signal.aborted) {
        await load(queryRef.current, controller.signal);
      }
    } catch (error) {
      if (!isAbortError(error)) {
        setActionError(error instanceof Error ? error.message : '审批处理失败。');
      }
    } finally {
      if (actionInFlightRef.current === approval.id) {
        actionInFlightRef.current = undefined;
        actionControllerRef.current = undefined;
        setBusyId('');
      }
    }
  };

  if (state.status === 'loading') {
    return <div className="approval-state">正在加载审批…</div>;
  }
  if (state.status === 'error') {
    return (
      <div className="approval-state error" role="alert">
        {state.message}
        <button onClick={() => void load(queryRef.current)} type="button">
          重试
        </button>
      </div>
    );
  }

  return (
    <main className="approvals-page">
      <header className="approvals-header">
        <div>
          <h1>审批中心</h1>
          <p>审核将个人 Skills 和 Playbooks 分享给团队的申请。</p>
        </div>
      </header>
      <section aria-label="审批指标" className="approval-kpis">
        <Metric label="待处理" note="需要管理员处理" tone="warning" value={state.summary.pending} />
        <Metric label="已通过" note="过去 7 天" tone="success" value={state.summary.approved7d} />
        <Metric label="已拒绝" note="过去 7 天" tone="danger" value={state.summary.rejected7d} />
        <Metric
          label="平均处理时长"
          note={`SLA ${state.summary.slaHours}h`}
          value={`${state.summary.averageHandlingHours}h`}
        />
      </section>
      <section aria-label="审批筛选" className="approval-toolbar">
        <label>
          <Filter size={12} />
          <span>类型</span>
          <select
            aria-label="审批对象类型"
            onChange={(event) =>
              setQuery((value) => ({ ...value, objectType: (event.target.value as ApprovalObjectType) || undefined }))
            }
            value={query.objectType ?? ''}
          >
            <option value="">All</option>
            <option value="playbook">Playbook</option>
            <option value="skill">Skill</option>
          </select>
        </label>
        <label>
          <Folder size={12} />
          <span>目标 Folder</span>
          <select
            aria-label="目标 Folder"
            onChange={(event) => setQuery((value) => ({ ...value, targetFolderUid: event.target.value || undefined }))}
            value={effectiveTargetFolderUid ?? ''}
          >
            <option value="">All</option>
            {folders.status === 'success' &&
              folders.data.map((folder) => (
                <option key={folder.uid} value={folder.uid}>
                  {folder.title}
                </option>
              ))}
          </select>
        </label>
        <div className="approval-tabs">
          {(['pending', 'approved', 'rejected', 'all'] as const).map((status) => (
            <button
              aria-pressed={(query.status ?? 'all') === status}
              key={status}
              onClick={() =>
                setQuery((value) => ({ ...value, status: status === 'all' ? undefined : (status as ApprovalStatus) }))
              }
              type="button"
            >
              {status}
            </button>
          ))}
        </div>
      </section>
      {actionError && (
        <div className="approval-error" role="alert">
          {actionError}
        </div>
      )}
      <section aria-label="审批列表" className="approval-list">
        {state.approvals.map((approval) => {
          const admin = permissionByFolder[approval.targetFolderUid] === 'Admin';
          return (
            <ApprovalCard
              admin={admin}
              approval={approval}
              busy={busyId !== ''}
              key={approval.id}
              onApprove={() => void decide(approval)}
              onPreview={() => setPreview(approval)}
              onReject={() => {
                setRejectReason('');
                setRejecting(approval);
              }}
            />
          );
        })}
        {!state.approvals.length && <div className="approval-empty">当前筛选下没有审批记录。</div>}
      </section>
      {preview && <PreviewDialog approval={preview} onClose={() => setPreview(undefined)} />}
      {rejecting && (
        <div className="approval-modal-backdrop" role="presentation">
          <form
            aria-label={`拒绝 ${rejecting.objectTitle}`}
            aria-modal="true"
            className="approval-modal"
            ref={rejectDialogRef}
            role="dialog"
            onSubmit={(event) => {
              event.preventDefault();
              void decide(rejecting, rejectReason);
            }}
          >
            <header>
              <div>
                <h2>拒绝晋升</h2>
                <p>
                  {rejecting.objectTitle} → {rejecting.targetFolderTitle}
                </p>
              </div>
              <button aria-label="关闭拒绝对话框" onClick={() => setRejecting(undefined)} type="button">
                <X size={16} />
              </button>
            </header>
            <label>
              拒绝原因（必填）
              <textarea
                aria-label="拒绝原因"
                onChange={(event) => setRejectReason(event.currentTarget.value)}
                rows={5}
                value={rejectReason}
              />
            </label>
            {!rejectReason.trim() && <small>请说明需要修改的内容。</small>}
            <footer>
              <button onClick={() => setRejecting(undefined)} type="button">
                取消
              </button>
              <button className="danger" disabled={!rejectReason.trim() || busyId === rejecting.id} type="submit">
                确认拒绝
              </button>
            </footer>
          </form>
        </div>
      )}
    </main>
  );
}

function Metric({
  label,
  note,
  tone = '',
  value,
}: {
  label: string;
  note: string;
  tone?: string;
  value: React.ReactNode;
}) {
  return (
    <article>
      <span>{label}</span>
      <strong className={tone}>{value}</strong>
      <small>{note}</small>
    </article>
  );
}

function ApprovalCard({
  admin,
  approval,
  busy,
  onApprove,
  onPreview,
  onReject,
}: {
  admin: boolean;
  approval: Approval;
  busy: boolean;
  onApprove: () => void;
  onPreview: () => void;
  onReject: () => void;
}) {
  const pending = approval.status === 'pending';
  const Icon = approval.objectType === 'playbook' ? GitBranch : Wand2;
  return (
    <article className="approval-card">
      <div className={`approval-icon ${approval.objectType}`}>
        <Icon size={20} />
      </div>
      <div className="approval-card-body">
        <header>
          <code>{approval.objectTitle}</code>
          <span className="approval-tag">{approval.objectType}</span>
          <span className={`approval-tag ${approval.status}`}>{approval.status}</span>
          <time>
            <Clock size={11} /> {new Date(approval.createdAt).toLocaleString()}
          </time>
        </header>
        <div className="approval-request">
          <span>
            由 <strong>{approval.requestedBy}</strong> 申请共享到
          </span>
          <span className="approval-tag folder">
            <Folder size={10} /> {approval.targetFolderTitle}
          </span>
          <ArrowUpRight size={12} />
          <span className="approval-usage">
            usage_count: <code>{approval.usageCount}</code>
          </span>
        </div>
        {approval.draft.objectType === 'playbook' && (
          <div className="approval-preview">
            <GitBranch size={14} />
            <div>
              <strong>Playbook 步骤预览：</strong>
              <span>
                {approval.draft.definition.steps.length} steps · trigger: {approval.draft.definition.trigger.type}
              </span>
              <div>
                {approval.draft.definition.steps.slice(0, 4).map((step) => (
                  <span className="approval-tag" key={step.id}>
                    {step.type}: {step.label}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}
        {approval.draft.objectType === 'skill' && (
          <div className="approval-preview">
            <Wand2 size={14} />
            <div>
              <strong>Skill 草稿预览：</strong>
              <span>
                {approval.draft.definition.slashCommand} · {approval.draft.definition.allowedTools.length} tools
              </span>
            </div>
          </div>
        )}
        {approval.status === 'rejected' && (
          <div className="approval-result rejected">
            <MessageSquare size={14} />
            <div>
              <strong>拒绝评论：</strong>“{approval.rejectReason}”
              <small>
                reviewer: {approval.reviewerId} ·{' '}
                {approval.reviewedAt && new Date(approval.reviewedAt).toLocaleString()}
              </small>
            </div>
          </div>
        )}
        {approval.status === 'approved' && (
          <div className="approval-result approved">
            <Check size={14} />
            审批通过 · 已转为 shared，并绑定 Folder “{approval.targetFolderTitle}”
          </div>
        )}
        <footer>
          {pending && (
            <>
              <button
                className="approve"
                disabled={!admin || busy}
                onClick={onApprove}
                title={admin ? '' : '只有目标 Folder Admin 可以处理'}
                type="button"
              >
                <Check size={12} /> 通过
              </button>
              <button
                className="reject"
                disabled={!admin || busy}
                onClick={onReject}
                title={admin ? '' : '只有目标 Folder Admin 可以处理'}
                type="button"
              >
                <X size={12} /> 拒绝
              </button>
            </>
          )}
          <button onClick={onPreview} type="button">
            <Eye size={12} /> 查看完整草稿
          </button>
          {pending && !admin && <small>需要 {approval.targetFolderTitle} Folder Admin 权限</small>}
        </footer>
      </div>
    </article>
  );
}

function PreviewDialog({ approval, onClose }: { approval: Approval; onClose: () => void }) {
  const dialogRef = useDialogA11y<HTMLDivElement>(onClose);
  return (
    <div className="approval-modal-backdrop" role="presentation">
      <div
        aria-label={`${approval.objectTitle} 完整草稿`}
        aria-modal="true"
        className="approval-modal wide"
        ref={dialogRef}
        role="dialog"
      >
        <header>
          <div>
            <h2>{approval.objectTitle}</h2>
            <p>
              {approval.objectType} · revision {approval.recordVersion}
            </p>
          </div>
          <button aria-label="关闭草稿预览" onClick={onClose} type="button">
            <X size={16} />
          </button>
        </header>
        {approval.draft.objectType === 'playbook' ? (
          <>
            <dl>
              <div>
                <dt>描述</dt>
                <dd>{approval.draft.definition.description}</dd>
              </div>
              <div>
                <dt>Version</dt>
                <dd>{approval.draft.definition.version}</dd>
              </div>
              <div>
                <dt>Steps</dt>
                <dd>{approval.draft.definition.steps.length}</dd>
              </div>
            </dl>
            <h3>YAML</h3>
          </>
        ) : (
          <>
            <dl>
              <div>
                <dt>Slash Command</dt>
                <dd>{approval.draft.definition.slashCommand}</dd>
              </div>
              <div>
                <dt>Allowed tools</dt>
                <dd>{approval.draft.definition.allowedTools.join(', ') || '无'}</dd>
              </div>
            </dl>
            <h3>Frontmatter + Markdown</h3>
          </>
        )}
        <pre>{approval.draft.source}</pre>
        <footer>
          <button onClick={onClose} type="button">
            关闭
          </button>
        </footer>
      </div>
    </div>
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
