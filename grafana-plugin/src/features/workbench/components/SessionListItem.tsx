import React from 'react';
import { SessionSummary } from '../model';

interface SessionListItemProps {
  session: SessionSummary;
  active: boolean;
  onOpen: (sessionId: string) => void;
}

export function SessionListItem({ session, active, onOpen }: SessionListItemProps) {
  return (
    <button
      aria-current={active ? 'page' : undefined}
      className={`session-list-item${active ? ' active' : ''}`}
      data-testid={`session-item-${session.id}`}
      onClick={() => onOpen(session.id)}
      type="button"
    >
      <span className="session-title">{session.title}</span>
      {session.preview && <span className="session-preview">{session.preview}</span>}
      <span className="session-meta">
        <span>{session.folderTitle}</span>
        <span>·</span>
        <span>{session.messageCount} 条消息</span>
        <time dateTime={session.updatedAt}>{formatUpdatedAt(session.updatedAt)}</time>
      </span>
      <span className="session-badges">
        <span className={`tag ${session.visibility === 'team' ? 'purple' : 'muted'}`}>
          {session.visibility === 'team' ? '团队' : '私有'}
        </span>
        {session.forkedFrom && <span className="tag ok">分支会话</span>}
        {session.status === 'archived' && <span className="tag muted">已归档</span>}
      </span>
    </button>
  );
}

function formatUpdatedAt(value: string): string {
  const timestamp = new Date(value).getTime();
  const differenceMinutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
  if (differenceMinutes < 60) {
    return differenceMinutes <= 2 ? '2 分钟前' : `${differenceMinutes} 分钟前`;
  }
  if (differenceMinutes < 24 * 60) {
    return `今天 ${new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(
      new Date(value)
    )}`;
  }
  if (differenceMinutes < 48 * 60) {
    return '昨天';
  }
  if (differenceMinutes < 7 * 24 * 60) {
    return `${Math.floor(differenceMinutes / (24 * 60))} 天前`;
  }
  return '上周';
}
