import React, { useMemo, useState } from 'react';
import { AlertTriangle, Check, FileText, ShieldCheck, X } from 'lucide-react';
import { Folder } from '../../../app/model';
import { useDialogA11y } from '../../../utils/useDialogA11y';
import { PendingHITL } from '../model';

interface HITLModalProps {
  folder?: Folder;
  open: boolean;
  request: PendingHITL | null;
  onApprove: (comment?: string) => void;
  onClose: () => void;
  onReject: (reason: string) => void;
}

export function HITLModal({ folder, open, request, onApprove, onClose, onReject }: HITLModalProps) {
  const dialogRef = useDialogA11y<HTMLElement>(onClose, { enabled: open && Boolean(request) });
  const [tab, setTab] = useState<'preview' | 'json' | 'impact'>('preview');
  const [comment, setComment] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const args = useMemo(() => {
    try {
      return request ? (JSON.parse(request.args) as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }, [request]);

  if (!open || !request) {
    return null;
  }
  const canApprove = Boolean(folder && folder.permission !== 'View');

  return (
    <div className="workbench-modal-backdrop" role="presentation">
      <section
        aria-label="写操作需审批"
        aria-modal="true"
        className="hitl-modal"
        ref={dialogRef}
        role="dialog"
      >
        <header>
          <span className="hitl-icon">
            <ShieldCheck aria-hidden size={20} />
          </span>
          <span>
            <strong>写操作需审批</strong>
            <small>确认影响范围后再继续执行</small>
          </span>
          <button aria-label="稍后处理审批" className="icon-button" onClick={onClose} type="button">
            <X aria-hidden size={17} />
          </button>
        </header>
        <div className="hitl-body">
          <div className="hitl-summary">
            <code>
              {request.server}.{request.tool}
            </code>
            <span className="tag warning">写操作</span>
            <p>{request.reason}</p>
          </div>
          <div className={`permission-banner ${canApprove ? 'allowed' : 'denied'}`}>
            {canApprove ? <Check aria-hidden size={15} /> : <AlertTriangle aria-hidden size={15} />}
            {!folder
              ? '暂时无法验证 Folder 权限，审批操作已锁定。'
              : canApprove
                ? `权限校验通过：当前用户对 Folder "${folder.title}" 有 ${folder.permission} 权限。`
                : `权限不足：当前用户对 Folder "${folder.title}" 只有 View 权限。`}
          </div>
          <div className="hitl-tabs">
            {(['preview', 'json', 'impact'] as const).map((value) => (
              <button
                className={tab === value ? 'active' : ''}
                key={value}
                onClick={() => setTab(value)}
                type="button"
              >
                {value === 'preview' ? '更改预览' : value === 'json' ? '请求参数' : '影响范围'}
              </button>
            ))}
          </div>
          {tab === 'preview' && (
            <pre className="hitl-preview">
              {request.preview.map((line) => (
                <span
                  className={line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : 'changed'}
                  key={line}
                >
                  {line}
                </span>
              ))}
            </pre>
          )}
          {tab === 'json' && <pre className="hitl-json">{args ? JSON.stringify(args, null, 2) : request.args}</pre>}
          {tab === 'impact' && (
            <div className="impact-list">
              <Impact icon={<FileText size={14} />} label="目标资源" value={String(args?.dashboard ?? 'checkout-overview')} />
              <Impact icon={<ShieldCheck size={14} />} label="影响 Folder" value={folder?.title ?? '未加载'} />
              <Impact icon={<AlertTriangle size={14} />} label="风险等级" value="低 · 可通过仪表盘历史版本恢复" />
              <Impact icon={<FileText size={14} />} label="操作结果" value="以服务端返回的实际结果为准" />
            </div>
          )}
          {rejecting ? (
            <label className="hitl-field rejecting">
              <span>拒绝原因（必填）</span>
              <textarea
                aria-label="拒绝原因"
                onChange={(event) => setRejectReason(event.currentTarget.value)}
                placeholder="例如：变更范围不符合预期..."
                value={rejectReason}
              />
            </label>
          ) : (
            <label className="hitl-field">
              <span>审批备注（可选）</span>
              <textarea
                aria-label="审批备注"
                onChange={(event) => setComment(event.currentTarget.value)}
                placeholder="例如：确认修改，关联到 #INC-1234"
                value={comment}
              />
            </label>
          )}
        </div>
        <footer>
          <span>
            是否执行及留痕以服务端返回结果为准
          </span>
          {rejecting ? (
            <>
              <button className="btn btn-secondary" onClick={() => setRejecting(false)} type="button">
                返回
              </button>
              <button
                className="btn btn-danger"
                disabled={!rejectReason.trim()}
                onClick={() => onReject(rejectReason.trim())}
                type="button"
              >
                确认拒绝
              </button>
            </>
          ) : (
            <>
              <button className="btn btn-secondary" onClick={onClose} type="button">
                稍后处理
              </button>
              <button className="btn btn-danger" onClick={() => setRejecting(true)} type="button">
                拒绝
              </button>
              <button
                className="btn btn-primary"
                disabled={!canApprove}
                onClick={() => onApprove(comment.trim() || undefined)}
                type="button"
              >
                批准执行
              </button>
            </>
          )}
        </footer>
      </section>
    </div>
  );
}

function Impact({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div>
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
