import React, { DragEvent, useRef, useState } from 'react';
import { Edit2, Eye, FileCode, Trash2, Upload, X } from 'lucide-react';
import { Folder } from '../../../app/model';
import { useDialogA11y } from '../../../utils/useDialogA11y';
import { KnowledgeDocument, ServiceEntry } from '../model';

export function DocumentsView({
  documents,
  folder,
  services,
  writable,
  onDelete,
  onEdit,
  onFiles,
  onPreview,
}: {
  documents: KnowledgeDocument[];
  folder: Folder;
  services: ServiceEntry[];
  writable: boolean;
  onDelete: (document: KnowledgeDocument) => void;
  onEdit: (document: KnowledgeDocument) => void;
  onFiles: (files: File[]) => void;
  onPreview: (document: KnowledgeDocument) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const selectFiles = (files: FileList | null) => {
    if (files?.length) {
      onFiles(Array.from(files));
    }
  };
  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (writable) {
      selectFiles(event.dataTransfer.files);
    }
  };

  return (
    <>
      <div className="knowledge-page-header">
        <div>
          <h1>文档 · {folder.title}</h1>
          <p>导入并管理调查过程中可以引用的文档。</p>
        </div>
        <button className="knowledge-button primary" disabled={!writable} onClick={() => inputRef.current?.click()} type="button">
          <Upload size={13} /> 导入文档
        </button>
      </div>
      <input
        accept=".md,.pdf,.docx,.html,.htm,.txt,.zip"
        data-testid="knowledge-file-input"
        hidden
        multiple
        onChange={(event) => {
          selectFiles(event.currentTarget.files);
          event.currentTarget.value = '';
        }}
        ref={inputRef}
        type="file"
      />
      <div
        aria-disabled={!writable}
        className={`document-dropzone${dragging ? ' dragging' : ''}${!writable ? ' disabled' : ''}`}
        onDragEnter={(event) => {
          event.preventDefault();
          if (writable) {
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDragOver={(event) => event.preventDefault()}
        onDrop={drop}
      >
        <span><Upload aria-hidden size={28} /></span>
        <h2>拖拽文件到此处导入</h2>
        <p>支持 Markdown / PDF / DOCX / HTML / Confluence 导出 ZIP</p>
        <small>单文件 ≤ 10MB · 单次最多 100 个文件</small>
      </div>
      <section aria-label="Document 列表" className="document-grid">
        {documents.map((document) => (
          <article className="knowledge-card document-card" key={document.id}>
            <FileCode aria-hidden size={28} />
            <div>
              <strong>{document.name}</strong>
              <span>{document.format} · {document.chunks} chunks · {formatBytes(document.sizeBytes)}</span>
              <small>{document.importedBy} · {formatDate(document.updatedAt)}{document.serviceId ? ` · ${serviceName(services, document.serviceId)}` : ''}</small>
            </div>
            <div>
              <button aria-label={`预览 ${document.name}`} onClick={() => onPreview(document)} type="button"><Eye size={13} /></button>
              <button aria-label={`编辑 ${document.name}`} disabled={!writable} onClick={() => onEdit(document)} type="button"><Edit2 size={13} /></button>
              <button aria-label={`删除文档 ${document.name}`} disabled={!writable} onClick={() => onDelete(document)} type="button"><Trash2 size={13} /></button>
            </div>
          </article>
        ))}
        {documents.length === 0 && <div className="knowledge-empty">当前空间尚未导入文档。</div>}
      </section>
    </>
  );
}

export function DocumentPreviewModal({
  document,
  services,
  onClose,
}: {
  document: KnowledgeDocument;
  services: ServiceEntry[];
  onClose: () => void;
}) {
  const dialogRef = useDialogA11y<HTMLElement>(onClose);
  return (
    <div className="knowledge-modal-backdrop" role="presentation">
      <section
        aria-label={`预览文档 ${document.name}`}
        aria-modal="true"
        className="knowledge-modal document-preview-modal"
        ref={dialogRef}
        role="dialog"
      >
        <header><strong>{document.name}</strong><button aria-label="关闭文档预览" onClick={onClose} type="button"><X size={16} /></button></header>
        <dl>
          <div><dt>Format</dt><dd>{document.format}</dd></div>
          <div><dt>Chunks</dt><dd>{document.chunks}</dd></div>
          <div><dt>Service</dt><dd>{document.serviceId ? serviceName(services, document.serviceId) : '未关联'}</dd></div>
          <div><dt>Tags</dt><dd>{document.tags.join(', ') || '—'}</dd></div>
          <div><dt>Version</dt><dd>{document.version}</dd></div>
        </dl>
        <pre>{document.preview}</pre>
      </section>
    </div>
  );
}

function serviceName(services: ServiceEntry[], id: string): string {
  const service = services.find((candidate) => candidate.id === id);
  return service ? `@${service.name}` : id;
}

function formatBytes(value: number): string {
  return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(value > 1024 * 1024 ? 0 : 1)} KB`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('zh-CN');
}
