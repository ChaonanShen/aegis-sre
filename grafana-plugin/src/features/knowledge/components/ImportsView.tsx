import React, { useRef } from 'react';
import { AlertCircle, CheckCircle2, Clock, Eye, RotateCcw, Trash2, Upload, XCircle } from 'lucide-react';
import { Folder } from '../../../app/model';
import { ImportTask } from '../model';

export function ImportsView({
  folder,
  imports,
  importing,
  writable,
  onCancel,
  onDelete,
  onFiles,
  onOpen,
  onRetry,
}: {
  folder: Folder;
  imports: ImportTask[];
  importing: boolean;
  writable: boolean;
  onCancel: (task: ImportTask) => void;
  onDelete: (task: ImportTask) => void;
  onFiles: (files: File[]) => void;
  onOpen: (task: ImportTask) => void;
  onRetry: (task: ImportTask) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <div className="knowledge-page-header">
        <div>
          <h1>导入任务 · {folder.title}</h1>
          <p>查看文档处理进度并确认导入结果。</p>
        </div>
        <button className="knowledge-button primary" disabled={!writable || importing} onClick={() => inputRef.current?.click()} type="button">
          <Upload size={13} /> 新建导入
        </button>
      </div>
      <input
        accept=".md,.pdf,.docx,.html,.htm,.txt,.zip"
        data-testid="import-file-input"
        hidden
        multiple
        onChange={(event) => {
          if (event.currentTarget.files?.length) {
            onFiles(Array.from(event.currentTarget.files));
          }
          event.currentTarget.value = '';
        }}
        ref={inputRef}
        type="file"
      />
      <section aria-label="Import Task 列表" className="import-task-list">
        {imports.map((task) => (
          <article className="knowledge-card import-task" key={task.id}>
            <TaskIcon status={task.status} />
            <div className="import-task-copy">
              <header>
                <strong>Import to {folder.title}</strong>
                <span className={`import-status ${task.status}`}>{task.status}</span>
                <time>{formatDate(task.startedAt)}</time>
              </header>
              <span>{task.files} 文件 · {task.failed} 失败 · by {task.importedBy} · {task.id}</span>
              <div aria-label={`导入进度 ${task.progress}%`} className="import-progress">
                <span className={task.status} style={{ width: `${task.progress}%` }} />
              </div>
            </div>
            <div className="import-actions">
              {task.status === 'reviewing' && <button className="knowledge-button primary small" onClick={() => onOpen(task)} type="button">查看 → 确认</button>}
              {task.status === 'done' && <button className="knowledge-button secondary small" onClick={() => onOpen(task)} type="button"><Eye size={12} /> 查看结果</button>}
              {task.status === 'failed' && <button className="knowledge-button secondary small" disabled={!writable || importing} onClick={() => onRetry(task)} type="button"><RotateCcw size={12} /> 重试</button>}
              {task.status === 'parsing' && <button className="knowledge-button secondary small" disabled={!writable || importing} onClick={() => onCancel(task)} type="button">取消</button>}
              {task.status !== 'parsing' && <button aria-label={`删除导入任务 ${task.id}`} className="knowledge-danger-icon" disabled={!writable} onClick={() => onDelete(task)} type="button"><Trash2 size={13} /></button>}
            </div>
          </article>
        ))}
        {imports.length === 0 && <div className="knowledge-empty">当前空间暂无导入任务。</div>}
      </section>
      <div className="knowledge-permission-banner import-hint">
        <AlertCircle size={14} />
        <span><strong>确认前可以调整：</strong>标签、作者和关联服务。遇到失败文件时，可以跳过失败项并继续导入。</span>
      </div>
    </>
  );
}

function TaskIcon({ status }: { status: ImportTask['status'] }) {
  if (status === 'done') {
    return <CheckCircle2 aria-hidden className="task-icon done" size={18} />;
  }
  if (status === 'failed' || status === 'cancelled') {
    return <XCircle aria-hidden className="task-icon failed" size={18} />;
  }
  return <Clock aria-hidden className={`task-icon ${status}`} size={18} />;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}
