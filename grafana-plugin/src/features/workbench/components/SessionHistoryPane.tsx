import React, { useMemo, useState } from 'react';
import { PanelLeftClose, Plus, Search } from 'lucide-react';
import { AsyncState } from '../application/useWorkbenchController';
import { SessionSummary } from '../model';
import { SessionListItem } from './SessionListItem';

interface SessionHistoryPaneProps {
  sessions: AsyncState<SessionSummary[]>;
  activeSessionId?: string;
  creating: boolean;
  onClose: () => void;
  onCreate: () => void;
  onOpen: (sessionId: string) => void;
  onRetry: () => void;
}

export function SessionHistoryPane({
  sessions,
  activeSessionId,
  creating,
  onClose,
  onCreate,
  onOpen,
  onRetry,
}: SessionHistoryPaneProps) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    if (sessions.status !== 'success') {
      return [];
    }
    const normalized = query.trim().toLocaleLowerCase();
    return normalized
      ? sessions.data.filter((session) =>
          `${session.title} ${session.folderTitle} ${session.preview}`.toLocaleLowerCase().includes(normalized)
        )
      : sessions.data;
  }, [query, sessions]);

  return (
    <aside aria-label="会话历史" className="chat-pane history" id="workbench-history-pane">
      <div className="pane-header">
        <span className="pane-heading">
          <strong>调查记录</strong>
          {sessions.status === 'success' && <small>{sessions.data.length} 个会话</small>}
        </span>
        <span className="pane-header-spacer" />
        <button aria-label="新建会话" className="icon-button" disabled={creating} onClick={onCreate} type="button">
          <Plus aria-hidden size={16} />
        </button>
        <button aria-label="收起会话历史" className="icon-button" onClick={onClose} type="button">
          <PanelLeftClose aria-hidden size={16} />
        </button>
      </div>
      <div className="pane-body">
        <label className="session-search">
          <Search aria-hidden size={14} />
          <input
            aria-label="搜索会话"
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="搜索标题、Folder 或消息"
            value={query}
          />
        </label>
        {sessions.status === 'loading' && <div className="pane-state">正在加载会话…</div>}
        {sessions.status === 'error' && (
          <div className="pane-state">
            <span>会话加载失败</span>
            <button className="btn btn-secondary btn-sm" onClick={onRetry} type="button">
              重试
            </button>
          </div>
        )}
        {sessions.status === 'success' && filtered.length === 0 && (
          <div className="pane-state">{query ? '没有匹配的会话' : '还没有会话'}</div>
        )}
        {filtered.map((session) => (
          <SessionListItem
            active={session.id === activeSessionId}
            key={session.id}
            onOpen={onOpen}
            session={session}
          />
        ))}
      </div>
    </aside>
  );
}
