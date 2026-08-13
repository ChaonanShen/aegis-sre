import React from 'react';
import { useDialogA11y } from '../../../utils/useDialogA11y';

export function ConfirmDialog({
  title,
  children,
  confirming,
  onCancel,
  onConfirm,
}: React.PropsWithChildren<{
  title: string;
  confirming: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}>) {
  const dialogRef = useDialogA11y<HTMLElement>(() => {
    if (!confirming) {
      onCancel();
    }
  });
  return (
    <div className="knowledge-modal-backdrop" role="presentation">
      <section
        aria-label={title}
        aria-modal="true"
        className="knowledge-modal confirm-modal"
        ref={dialogRef}
        role="dialog"
      >
        <header><strong>{title}</strong></header>
        <div className="confirm-copy">{children}</div>
        <footer>
          <button className="knowledge-button secondary" disabled={confirming} onClick={onCancel} type="button">取消</button>
          <button className="knowledge-button danger" disabled={confirming} onClick={onConfirm} type="button">
            {confirming ? '处理中…' : '确认删除'}
          </button>
        </footer>
      </section>
    </div>
  );
}
