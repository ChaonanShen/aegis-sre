import React from 'react';
import { Edit2, FileText, History, Plus, Search, Tag, Trash2, X } from 'lucide-react';
import { Folder } from '../../../app/model';
import { useDialogA11y } from '../../../utils/useDialogA11y';
import { Runbook, ServiceEntry } from '../model';

export function RunbooksView({
  folder,
  runbooks,
  services,
  selected,
  query,
  writable,
  onCreate,
  onDelete,
  onEdit,
  onHistory,
  onQueryChange,
  onSelect,
}: {
  folder: Folder;
  runbooks: Runbook[];
  services: ServiceEntry[];
  selected?: Runbook;
  query: string;
  writable: boolean;
  onCreate: () => void;
  onDelete: (runbook: Runbook) => void;
  onEdit: (runbook: Runbook) => void;
  onHistory: (runbook: Runbook) => void;
  onQueryChange: (query: string) => void;
  onSelect: (id: string) => void;
}) {
  return (
    <>
      <div className="knowledge-page-header">
        <div>
          <h1>Runbook · {folder.title}</h1>
          <p>管理调查与处置过程中可复用的操作指南。</p>
        </div>
        <button className="knowledge-button primary" disabled={!writable} onClick={onCreate} type="button">
          <Plus aria-hidden size={13} /> 新建 Runbook
        </button>
      </div>
      <div className="runbook-workspace">
        <section aria-label="Runbook 列表" className="knowledge-card runbook-list">
          <div className="service-search">
            <Search aria-hidden size={13} />
            <input aria-label="搜索 Runbook" onChange={(event) => onQueryChange(event.currentTarget.value)} placeholder="搜索标题、标签或作者..." value={query} />
          </div>
          {runbooks.length === 0 && <div className="knowledge-empty">当前空间下没有匹配的 Runbook。</div>}
          {runbooks.map((runbook) => (
            <button
              aria-current={runbook.id === selected?.id ? 'true' : undefined}
              className={`runbook-row${runbook.id === selected?.id ? ' active' : ''}`}
              key={runbook.id}
              onClick={() => onSelect(runbook.id)}
              type="button"
            >
              <span className="runbook-title"><FileText aria-hidden size={14} /><strong>{runbook.title}</strong></span>
              <span className="runbook-excerpt">{runbook.excerpt}</span>
              <span className="runbook-tags">
                {runbook.tags.map((tag) => <span className="tag" key={tag}><Tag aria-hidden size={9} />{tag}</span>)}
                <span className={`knowledge-severity ${runbook.severity}`}>{severityLabel(runbook.severity)}</span>
                <span className="tag">{runbook.source}</span>
              </span>
              <small>{runbook.author} · {formatDate(runbook.updatedAt)} · v{runbook.version}</small>
            </button>
          ))}
        </section>
        <section aria-label="Runbook 详情" className="knowledge-card runbook-detail">
          {!selected && <div className="knowledge-empty">选择一个 Runbook 查看正文。</div>}
          {selected && (
            <>
              <header>
                <div><h2>{selected.title}</h2><p>author: {selected.author} · updated: {formatDate(selected.updatedAt)}</p></div>
                <div>
                  <button className="knowledge-button secondary small" onClick={() => onHistory(selected)} type="button"><History size={12} /> History</button>
                  <button className="knowledge-button secondary small" disabled={!writable} onClick={() => onEdit(selected)} type="button"><Edit2 size={12} /> 编辑</button>
                  <button aria-label={`删除 Runbook ${selected.title}`} className="knowledge-danger-icon" disabled={!writable} onClick={() => onDelete(selected)} type="button"><Trash2 size={13} /></button>
                </div>
              </header>
              <RunbookFrontmatter runbook={selected} service={services.find(({ id }) => id === selected.serviceId)} />
              <pre className="runbook-body">{selected.body}</pre>
            </>
          )}
        </section>
      </div>
    </>
  );
}

export function RunbookHistoryModal({ runbook, onClose }: { runbook: Runbook; onClose: () => void }) {
  const dialogRef = useDialogA11y<HTMLElement>(onClose);
  return (
    <div className="knowledge-modal-backdrop" role="presentation">
      <section
        aria-label={`${runbook.title} 版本历史`}
        aria-modal="true"
        className="knowledge-modal history-modal"
        ref={dialogRef}
        role="dialog"
      >
        <header><strong>History · {runbook.title}</strong><button aria-label="关闭版本历史" onClick={onClose} type="button"><X size={16} /></button></header>
        <div className="history-list">
          <article className="history-entry current"><strong>v{runbook.version} · 当前版本</strong><span>{runbook.author} · {formatDate(runbook.updatedAt)}</span><pre>{runbook.body}</pre></article>
          {runbook.history.map((version) => (
            <article className="history-entry" key={version.version}><strong>v{version.version} · {version.title}</strong><span>{version.author} · {formatDate(version.savedAt)}</span><pre>{version.body}</pre></article>
          ))}
          {runbook.history.length === 0 && <div className="knowledge-empty">尚无历史版本。</div>}
        </div>
      </section>
    </div>
  );
}

function RunbookFrontmatter({ runbook, service }: { runbook: Runbook; service?: ServiceEntry }) {
  return (
    <pre className="runbook-frontmatter">{`---
title: ${runbook.title}
folder_uid: ${runbook.folderUid}
service: ${service?.name ?? ''}
tags: [${runbook.tags.join(', ')}]
severity: ${runbook.severity}
source: ${runbook.source}
version: ${runbook.version}
---`}</pre>
  );
}

function severityLabel(severity: Runbook['severity']): string {
  return severity === 'critical' ? 'P0' : severity === 'warning' ? 'P1' : 'info';
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}
