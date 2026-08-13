import React, { FormEvent, useState } from 'react';
import { X } from 'lucide-react';
import { useDialogA11y } from '../../../utils/useDialogA11y';
import {
  CreateRunbookInput,
  Runbook,
  RunbookSeverity,
  RunbookSource,
  ServiceEntry,
} from '../model';

export function RunbookFormModal({
  folderUid,
  initial,
  services,
  saving,
  onClose,
  onSubmit,
}: {
  folderUid: string;
  initial?: Runbook;
  services: ServiceEntry[];
  saving: boolean;
  onClose: () => void;
  onSubmit: (input: CreateRunbookInput) => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [serviceId, setServiceId] = useState(initial?.serviceId ?? '');
  const [tags, setTags] = useState(initial?.tags.join(', ') ?? '');
  const [severity, setSeverity] = useState<RunbookSeverity>(initial?.severity ?? 'warning');
  const [author, setAuthor] = useState(initial?.author ?? 'alice');
  const [source, setSource] = useState<RunbookSource>(initial?.source ?? 'manual');
  const [excerpt, setExcerpt] = useState(initial?.excerpt ?? '');
  const [body, setBody] = useState(initial?.body ?? '# Runbook\n\n');
  const dialogRef = useDialogA11y<HTMLElement>(() => {
    if (!saving) {
      onClose();
    }
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit({
      folderUid,
      title: title.trim(),
      serviceId: serviceId || undefined,
      tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      severity,
      author: author.trim(),
      source,
      excerpt: excerpt.trim(),
      body: body.trim(),
    });
  };

  return (
    <div className="knowledge-modal-backdrop" role="presentation">
      <section
        aria-label={initial ? '编辑 Runbook' : '新建 Runbook'}
        aria-modal="true"
        className="knowledge-modal runbook-form-modal"
        ref={dialogRef}
        role="dialog"
      >
        <header>
          <strong>{initial ? `编辑 ${initial.title}` : '新建 Runbook'}</strong>
          <button aria-label="关闭 Runbook 表单" disabled={saving} onClick={onClose} type="button">
            <X aria-hidden size={16} />
          </button>
        </header>
        <form onSubmit={submit}>
          <label>
            <span>标题</span>
            <input aria-label="Runbook 标题" autoFocus disabled={saving} onChange={(event) => setTitle(event.currentTarget.value)} required value={title} />
          </label>
          <div className="knowledge-form-grid">
            <label>
              <span>关联 Service</span>
              <select aria-label="关联 Service" disabled={saving} onChange={(event) => setServiceId(event.currentTarget.value)} value={serviceId}>
                <option value="">不关联</option>
                {services.map((service) => <option key={service.id} value={service.id}>@{service.name}</option>)}
              </select>
            </label>
            <label>
              <span>Severity</span>
              <select aria-label="Runbook Severity" disabled={saving} onChange={(event) => setSeverity(event.currentTarget.value as RunbookSeverity)} value={severity}>
                <option value="critical">critical</option>
                <option value="warning">warning</option>
                <option value="info">info</option>
              </select>
            </label>
            <label>
              <span>Author</span>
              <input aria-label="Runbook Author" disabled={saving} onChange={(event) => setAuthor(event.currentTarget.value)} required value={author} />
            </label>
            <label>
              <span>Source</span>
              <select aria-label="Runbook Source" disabled={saving} onChange={(event) => setSource(event.currentTarget.value as RunbookSource)} value={source}>
                <option value="manual">manual</option>
                <option value="imported">imported</option>
              </select>
            </label>
          </div>
          <label>
            <span>Tags</span>
            <input aria-label="Runbook Tags" disabled={saving} onChange={(event) => setTags(event.currentTarget.value)} placeholder="latency, oncall, p0" value={tags} />
          </label>
          <label>
            <span>摘要</span>
            <input aria-label="Runbook 摘要" disabled={saving} onChange={(event) => setExcerpt(event.currentTarget.value)} value={excerpt} />
          </label>
          <label>
            <span>Markdown 正文</span>
            <textarea aria-label="Runbook 正文" disabled={saving} onChange={(event) => setBody(event.currentTarget.value)} required rows={14} value={body} />
          </label>
          <footer>
            <button className="knowledge-button secondary" disabled={saving} onClick={onClose} type="button">取消</button>
            <button className="knowledge-button primary" disabled={saving || !title.trim() || !author.trim() || !body.trim()} type="submit">
              {saving ? '保存中…' : '保存'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
