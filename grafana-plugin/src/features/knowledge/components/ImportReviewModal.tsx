import React, { useState } from 'react';
import { AlertCircle, CheckCircle2, X } from 'lucide-react';
import { useDialogA11y } from '../../../utils/useDialogA11y';
import { ConfirmImportInput, ImportCandidate, ImportTask, ServiceEntry } from '../model';

export function ImportReviewModal({
  task,
  services,
  saving,
  writable,
  onClose,
  onConfirm,
}: {
  task: ImportTask;
  services: ServiceEntry[];
  saving: boolean;
  writable: boolean;
  onClose: () => void;
  onConfirm: (input: ConfirmImportInput) => void;
}) {
  const [candidates, setCandidates] = useState<ImportCandidate[]>(task.candidates);
  const [skipFailures, setSkipFailures] = useState(task.failed > 0);
  const dialogRef = useDialogA11y<HTMLElement>(() => {
    if (!saving) {
      onClose();
    }
  });
  const patch = (id: string, update: Partial<ImportCandidate>) =>
    setCandidates((current) => current.map((candidate) => candidate.id === id ? { ...candidate, ...update } : candidate));

  return (
    <div className="knowledge-modal-backdrop" role="presentation">
      <section
        aria-label={`确认导入任务 ${task.id}`}
        aria-modal="true"
        className="knowledge-modal import-review-modal"
        ref={dialogRef}
        role="dialog"
      >
        <header><strong>确认解析结果 · {task.files} files</strong><button aria-label="关闭导入确认" disabled={saving} onClick={onClose} type="button"><X size={16} /></button></header>
        <div className="import-candidates">
          {candidates.map((candidate) => (
            <article className={`import-candidate${candidate.error ? ' failed' : ''}`} key={candidate.id}>
              {candidate.error ? <AlertCircle aria-hidden size={15} /> : <CheckCircle2 aria-hidden size={15} />}
              <div>
                <strong>{candidate.name}</strong>
                <span>{candidate.format} · {candidate.sizeBytes} bytes</span>
                {candidate.error && <em>{candidate.error}</em>}
              </div>
              {!candidate.error && (
                <div className="candidate-fields">
                  <input aria-label={`${candidate.name} Tags`} disabled={!writable || saving} onChange={(event) => patch(candidate.id, { tags: event.currentTarget.value.split(',').map((tag) => tag.trim()).filter(Boolean) })} placeholder="tags, comma-separated" value={candidate.tags.join(', ')} />
                  <input aria-label={`${candidate.name} Author`} disabled={!writable || saving} onChange={(event) => patch(candidate.id, { author: event.currentTarget.value })} value={candidate.author} />
                  <select aria-label={`${candidate.name} Service`} disabled={!writable || saving} onChange={(event) => patch(candidate.id, { serviceId: event.currentTarget.value || undefined })} value={candidate.serviceId ?? ''}>
                    <option value="">不关联 Service</option>
                    {services.map((service) => <option key={service.id} value={service.id}>@{service.name}</option>)}
                  </select>
                </div>
              )}
            </article>
          ))}
        </div>
        {task.failed > 0 && (
          <label className="skip-failures">
            <input checked={skipFailures} disabled={!writable || saving} onChange={(event) => setSkipFailures(event.currentTarget.checked)} type="checkbox" />
            跳过失败文件，仅导入成功文件
          </label>
        )}
        <footer>
          <button className="knowledge-button secondary" disabled={saving} onClick={onClose} type="button">稍后处理</button>
          <button className="knowledge-button primary" disabled={!writable || saving || (task.failed > 0 && !skipFailures)} onClick={() => onConfirm({ taskId: task.id, skipFailures, candidates })} type="button">
            {saving ? '正在入库…' : '确认入库'}
          </button>
        </footer>
      </section>
    </div>
  );
}

export function ImportResultModal({ task, onClose }: { task: ImportTask; onClose: () => void }) {
  const dialogRef = useDialogA11y<HTMLElement>(onClose);
  return (
    <div className="knowledge-modal-backdrop" role="presentation">
      <section
        aria-label={`导入任务 ${task.id} 结果`}
        aria-modal="true"
        className="knowledge-modal"
        ref={dialogRef}
        role="dialog"
      >
        <header><strong>导入结果</strong><button aria-label="关闭导入结果" onClick={onClose} type="button"><X size={16} /></button></header>
        <div className="import-result">
          <CheckCircle2 size={28} />
          <h2>已生成 {task.createdDocumentIds.length} 个文档</h2>
          <p>{task.failed > 0 ? `${task.failed} 个失败文件已跳过。` : '所有文件均已成功解析并入库。'}</p>
          <code>{task.createdDocumentIds.join('\n') || '没有可显示的文档编号'}</code>
        </div>
      </section>
    </div>
  );
}
