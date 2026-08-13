import React from 'react';
import { AlertTriangle, Trash2, X } from 'lucide-react';
import { useDialogA11y } from '../../../utils/useDialogA11y';

interface DeleteSessionModalProps {
  deleting: boolean;
  disabled?: boolean;
  error?: string;
  open: boolean;
  sessionTitle: string;
  onClose: () => void;
  onConfirm: () => void;
}

export function DeleteSessionModal({
  deleting,
  disabled = false,
  error,
  open,
  sessionTitle,
  onClose,
  onConfirm,
}: DeleteSessionModalProps) {
  const dialogRef = useDialogA11y(
    () => {
      if (!deleting) {
        onClose();
      }
    },
    { enabled: open }
  );

  if (!open) {
    return null;
  }

  return (
    <div className="workbench-modal-backdrop" role="presentation">
      <section
        aria-labelledby="delete-session-title"
        aria-modal="true"
        className="delete-session-modal"
        ref={dialogRef}
        role="dialog"
      >
        <header>
          <span className="delete-session-icon">
            <AlertTriangle aria-hidden size={19} />
          </span>
          <span>
            <strong id="delete-session-title">删除会话</strong>
            <small>此操作无法撤销</small>
          </span>
          <button aria-label="关闭删除确认" className="icon-button" disabled={deleting} onClick={onClose} type="button">
            <X aria-hidden size={17} />
          </button>
        </header>
        <div className="delete-session-body">
          <p>确定删除这个会话吗？</p>
          <strong className="delete-session-target">{sessionTitle}</strong>
          <p className="delete-session-warning">会话中的消息、查询、图表和画布内容将一起删除。</p>
          {disabled && <p className="delete-session-disabled">请先停止当前生成，再删除会话。</p>}
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
        </div>
        <footer>
          <button autoFocus className="btn btn-secondary" disabled={deleting} onClick={onClose} type="button">
            取消
          </button>
          <button className="btn btn-danger" disabled={deleting || disabled} onClick={onConfirm} type="button">
            <Trash2 aria-hidden size={13} />
            {deleting ? '删除中…' : '删除会话'}
          </button>
        </footer>
      </section>
    </div>
  );
}
