import React from 'react';
import { Database, Edit2, FileText, GitBranch, Plus, Search, Server, Settings, Trash2, X } from 'lucide-react';
import { Folder } from '../../../app/model';
import { useDialogA11y } from '../../../utils/useDialogA11y';
import { ServiceEntry } from '../model';

export function ServicesView({
  folder,
  services,
  selected,
  query,
  writable,
  onCreate,
  onDelete,
  onEdit,
  onQueryChange,
  onSelect,
  onYaml,
}: {
  folder: Folder;
  services: ServiceEntry[];
  selected?: ServiceEntry;
  query: string;
  writable: boolean;
  onCreate: () => void;
  onDelete: (service: ServiceEntry) => void;
  onEdit: (service: ServiceEntry) => void;
  onQueryChange: (query: string) => void;
  onSelect: (id: string) => void;
  onYaml: () => void;
}) {
  return (
    <>
      <div className="knowledge-page-header">
        <div>
          <h1>服务 · {folder.title}</h1>
          <p>管理服务、负责人和调查时常用的关键指标。</p>
        </div>
        <div className="knowledge-header-actions">
          <button className="knowledge-button secondary" onClick={onYaml} type="button">
            <Settings aria-hidden size={13} /> YAML 预览
          </button>
          <button
            className="knowledge-button primary"
            disabled={!writable}
            onClick={onCreate}
            title={writable ? undefined : '当前 Folder 只有 View 权限'}
            type="button"
          >
            <Plus aria-hidden size={13} /> 新建服务
          </button>
        </div>
      </div>
      <div className="knowledge-permission-banner">
        <Database aria-hidden size={15} />
        <span>
          <strong>当前权限：{folder.permission}</strong>
          {writable ? '，你可以新增或编辑服务。' : '，你可以查看服务；编辑需要更高权限。'}
        </span>
      </div>
      <div className="service-workspace">
        <section aria-label="Service 列表" className="knowledge-card service-list">
          <div className="service-search">
            <Search aria-hidden size={13} />
            <input
              aria-label="搜索服务"
              onChange={(event) => onQueryChange(event.currentTarget.value)}
              placeholder="搜索服务名..."
              value={query}
            />
            <button aria-label="快速新建 Service" disabled={!writable} onClick={onCreate} type="button">
              <Plus aria-hidden size={14} />
            </button>
          </div>
          <div className="service-list-body">
            {services.length === 0 && <div className="knowledge-empty">当前空间下没有匹配的服务。</div>}
            {services.map((service) => (
              <button
                aria-current={service.id === selected?.id ? 'true' : undefined}
                className={`service-row${service.id === selected?.id ? ' active' : ''}`}
                key={service.id}
                onClick={() => onSelect(service.id)}
                type="button"
              >
                <span className="service-row-title">
                  <Server aria-hidden size={14} />
                  <strong>{service.name}</strong>
                  <span className={`knowledge-tier ${service.tier}`}>{service.tier}</span>
                  <time>{formatUpdatedAt(service.updatedAt)}</time>
                </span>
                <span>{service.displayName} · {service.owner}</span>
                <small>
                  {service.keyMetrics.length} metrics　 {service.runbookCount} runbooks　 {service.playbookCount} playbooks
                </small>
              </button>
            ))}
          </div>
        </section>
        <section aria-label="Service 详情" className="knowledge-card service-detail">
          {!selected && <div className="knowledge-empty">选择一个服务查看详情。</div>}
          {selected && (
            <>
              <header>
                <div>
                  <h2>@{selected.name}</h2>
                  <p>{selected.displayName}</p>
                </div>
                <div>
                  <button
                    className="knowledge-button secondary small"
                    disabled={!writable}
                    onClick={() => onEdit(selected)}
                    type="button"
                  >
                    <Edit2 aria-hidden size={12} /> 编辑
                  </button>
                  <button
                    aria-label={`删除 ${selected.name}`}
                    className="knowledge-danger-icon"
                    disabled={!writable}
                    onClick={() => onDelete(selected)}
                    type="button"
                  >
                    <Trash2 aria-hidden size={13} />
                  </button>
                </div>
              </header>
              <div className="service-metadata">
                <div><span>Owner</span><strong>{selected.owner}</strong></div>
                <div><span>Tier</span><strong className={`knowledge-tier ${selected.tier}`}>{selected.tier}</strong></div>
                <div><span>Folder</span><strong className="tag info">{selected.folderUid}</strong></div>
                <div><span>Updated</span><strong>{formatUpdatedAt(selected.updatedAt)}</strong></div>
              </div>
              <h3>KEY METRICS</h3>
              <div className="metrics-table-wrap">
                <table className="metrics-table">
                  <thead><tr><th>Name</th><th>Expr</th><th>Threshold</th></tr></thead>
                  <tbody>
                    {selected.keyMetrics.map((metric) => (
                      <tr key={metric.name}>
                        <td><code>{metric.name}</code></td>
                        <td><code>{metric.expr}</code></td>
                        <td><span className="tag">{metric.threshold}</span></td>
                      </tr>
                    ))}
                    {selected.keyMetrics.length === 0 && <tr><td colSpan={3}>尚未配置 Key Metrics</td></tr>}
                  </tbody>
                </table>
              </div>
              <h3>关联资源</h3>
              <div className="related-resources">
                <div><FileText aria-hidden size={13} /><strong>{selected.runbookCount} runbooks</strong><span>Markdown · 关联到此 service</span></div>
                <div><GitBranch aria-hidden size={13} /><strong>{selected.playbookCount} playbooks</strong><span>与此服务关联的处置流程</span></div>
              </div>
              <footer>
                版本 <code>v{selected.version}</code> · 当前权限{' '}
                <span className={`perm ${folder.permission.toLocaleLowerCase()}`}>{folder.permission}</span> 权限
              </footer>
            </>
          )}
        </section>
      </div>
    </>
  );
}

export function YamlPreview({
  services,
  onClose,
}: {
  services: ServiceEntry[];
  onClose: () => void;
}) {
  const dialogRef = useDialogA11y<HTMLElement>(onClose);
  const yaml = services
    .map(
      (service) =>
        `- name: ${service.name}\n  display_name: ${service.displayName}\n  folder_uid: ${service.folderUid}\n  owner: ${service.owner}\n  tier: ${service.tier}\n  version: ${service.version}`
    )
    .join('\n');
  return (
    <div className="knowledge-modal-backdrop" role="presentation">
      <section
        aria-label="Service YAML 预览"
        aria-modal="true"
        className="knowledge-modal yaml-modal"
        ref={dialogRef}
        role="dialog"
      >
        <header><strong>Service YAML 预览</strong><button aria-label="关闭 YAML 预览" onClick={onClose} type="button"><X size={16} /></button></header>
        <pre>{yaml || '# 当前 Folder 暂无 Service'}</pre>
      </section>
    </div>
  );
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}
