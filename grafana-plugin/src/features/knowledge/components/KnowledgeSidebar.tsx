import React from 'react';
import { FileCode, FileText, Folder as FolderIcon, RefreshCw, Server, Upload } from 'lucide-react';
import { Folder } from '../../../app/model';
import { AsyncState } from '../application/useKnowledgeController';
import { KnowledgeSnapshot, KnowledgeTab } from '../model';

const resources: Array<{ tab: KnowledgeTab; label: string; icon: typeof Server }> = [
  { tab: 'services', label: '服务', icon: Server },
  { tab: 'runbooks', label: 'Runbooks', icon: FileText },
  { tab: 'documents', label: '文档', icon: FileCode },
  { tab: 'imports', label: '导入任务', icon: Upload },
];

export function KnowledgeSidebar({
  activeFolder,
  folders,
  folderLoading,
  snapshot,
  tab,
  onFolderChange,
  onRefreshFolders,
  onTabChange,
}: {
  activeFolder?: Folder;
  folders: Folder[];
  folderLoading: boolean;
  snapshot: AsyncState<KnowledgeSnapshot>;
  tab: KnowledgeTab;
  onFolderChange: (uid: string) => void;
  onRefreshFolders: () => void;
  onTabChange: (tab: KnowledgeTab) => void;
}) {
  const counts = snapshot.status === 'success' ? snapshot.data.counts : undefined;

  return (
    <aside aria-label="知识库导航" className="knowledge-sidebar">
      <div className="knowledge-pane-header">
        <strong>Folders</strong>
        <button aria-label="刷新 Grafana Folder" className="knowledge-icon-button" onClick={onRefreshFolders} type="button">
          <RefreshCw aria-hidden size={13} />
        </button>
      </div>
      <div className="knowledge-folder-section">
        <div className="knowledge-hint">空间与权限来自 Grafana</div>
        {folderLoading && <div className="knowledge-side-state">正在加载 Folders…</div>}
        {!folderLoading &&
          folders.map((folder) => (
            <button
              aria-current={folder.uid === activeFolder?.uid ? 'true' : undefined}
              className={`knowledge-folder-row${folder.uid === activeFolder?.uid ? ' active' : ''}`}
              key={folder.uid}
              onClick={() => onFolderChange(folder.uid)}
              type="button"
            >
              <FolderIcon aria-hidden size={14} />
              <span>{folder.title}</span>
              <span className={`perm ${folder.permission.toLocaleLowerCase()}`}>{folder.permission}</span>
            </button>
          ))}
      </div>
      <div className="knowledge-sidebar-divider" />
      <div className="knowledge-pane-header">
        <strong>资源</strong>
      </div>
      <div className="knowledge-resource-list">
        {resources.map(({ tab: resourceTab, label, icon: Icon }) => (
          <button
            aria-current={tab === resourceTab ? 'page' : undefined}
            className={`knowledge-resource-row${tab === resourceTab ? ' active' : ''}`}
            key={resourceTab}
            onClick={() => onTabChange(resourceTab)}
            type="button"
          >
            <Icon aria-hidden size={14} />
            <span>{label}</span>
            <span className="tag">{counts?.[resourceTab] ?? '…'}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}
