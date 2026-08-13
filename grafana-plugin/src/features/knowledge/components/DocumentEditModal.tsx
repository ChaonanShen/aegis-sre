import React, { FormEvent, useState } from 'react';
import { X } from 'lucide-react';
import { useDialogA11y } from '../../../utils/useDialogA11y';
import { KnowledgeDocument, ServiceEntry, UpdateDocumentInput } from '../model';

export function DocumentEditModal({
  document,
  services,
  saving,
  onClose,
  onSubmit,
}: {
  document: KnowledgeDocument;
  services: ServiceEntry[];
  saving: boolean;
  onClose: () => void;
  onSubmit: (input: UpdateDocumentInput) => void;
}) {
  const [name, setName] = useState(document.name);
  const [tags, setTags] = useState(document.tags.join(', '));
  const [serviceId, setServiceId] = useState(document.serviceId ?? '');
  const [importedBy, setImportedBy] = useState(document.importedBy);
  const dialogRef = useDialogA11y<HTMLElement>(() => {
    if (!saving) {
      onClose();
    }
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit({
      name: name.trim(),
      tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      serviceId: serviceId || undefined,
      importedBy: importedBy.trim(),
    });
  };

  return (
    <div className="knowledge-modal-backdrop" role="presentation">
      <section
        aria-label={`编辑文档 ${document.name}`}
        aria-modal="true"
        className="knowledge-modal"
        ref={dialogRef}
        role="dialog"
      >
        <header>
          <strong>编辑 Document metadata</strong>
          <button aria-label="关闭文档编辑" disabled={saving} onClick={onClose} type="button"><X size={16} /></button>
        </header>
        <form onSubmit={submit}>
          <label><span>文件名</span><input aria-label="文档文件名" disabled={saving} onChange={(event) => setName(event.currentTarget.value)} required value={name} /></label>
          <label><span>Tags</span><input aria-label="文档 Tags" disabled={saving} onChange={(event) => setTags(event.currentTarget.value)} value={tags} /></label>
          <label>
            <span>关联 Service</span>
            <select aria-label="文档关联 Service" disabled={saving} onChange={(event) => setServiceId(event.currentTarget.value)} value={serviceId}>
              <option value="">不关联</option>
              {services.map((service) => <option key={service.id} value={service.id}>@{service.name}</option>)}
            </select>
          </label>
          <label><span>导入人</span><input aria-label="文档导入人" disabled={saving} onChange={(event) => setImportedBy(event.currentTarget.value)} required value={importedBy} /></label>
          <footer>
            <button className="knowledge-button secondary" disabled={saving} onClick={onClose} type="button">取消</button>
            <button className="knowledge-button primary" disabled={saving || !name.trim() || !importedBy.trim()} type="submit">{saving ? '保存中…' : '保存'}</button>
          </footer>
        </form>
      </section>
    </div>
  );
}
