import React, { useEffect, useRef, useState } from 'react';
import {
  Archive,
  Clipboard,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { Folder } from '../../../app/model';
import { MessageAttachment, OpenedSession, WorkbenchContext } from '../model';
import { Composer } from './Composer';
import { MessageBubble } from './MessageBubble';
import { QuickActions } from './QuickActions';

interface ChatPaneProps {
  opened: OpenedSession;
  activeFolder?: Folder;
  attachmentsEnabled: boolean;
  context?: WorkbenchContext;
  streaming: boolean;
  blockedByHITL: boolean;
  historyOpen: boolean;
  contextOpen: boolean;
  onArchive: () => void;
  onDelete: () => void;
  onSend: (value: string, attachments?: MessageAttachment[]) => void;
  onStop: () => void;
  onToggleHistory: () => void;
  onToggleContext: () => void;
}

export function ChatPane({
  opened,
  activeFolder,
  attachmentsEnabled,
  context,
  streaming,
  blockedByHITL,
  historyOpen,
  contextOpen,
  onArchive,
  onDelete,
  onSend,
  onStop,
  onToggleHistory,
  onToggleContext,
}: ChatPaneProps) {
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [opened.messages]);

  return (
    <section aria-label="对话" className="chat-pane chat-center">
      <div className="pane-header chat-header">
        <button
          aria-controls="workbench-history-pane"
          aria-expanded={historyOpen}
          aria-label={historyOpen ? '收起会话历史' : '展开会话历史'}
          className="icon-button"
          onClick={onToggleHistory}
          type="button"
        >
          {historyOpen ? <PanelLeftClose aria-hidden size={16} /> : <PanelLeftOpen aria-hidden size={16} />}
        </button>
        <Sparkles aria-hidden size={15} />
        <strong>{opened.session.title}</strong>
        <span className="tag muted" title={opened.session.id}>
          {opened.session.id.slice(0, 8)}
        </span>
        {streaming && <span className="tag warning">生成中</span>}
        <span className="pane-header-spacer" />
        <button
          aria-controls="workbench-context-pane"
          aria-expanded={contextOpen}
          aria-label={contextOpen ? '关闭上下文' : '打开上下文'}
          className="icon-button"
          onClick={onToggleContext}
          type="button"
        >
          {contextOpen ? <PanelRightClose aria-hidden size={16} /> : <PanelRightOpen aria-hidden size={16} />}
        </button>
        <SessionMenu
          archived={opened.session.status === 'archived'}
          key={`menu:${opened.session.id}`}
          onArchive={onArchive}
          onDelete={onDelete}
          streaming={streaming}
        />
      </div>
      <div className="pane-body messages" ref={bodyRef}>
        {opened.messages.length === 0 ? (
          opened.session.status === 'archived' ? (
            <div className="pane-state" role="status">
              此会话已归档，不能继续发送消息。
            </div>
          ) : (
            <QuickActions activeFolder={activeFolder} onPick={(value) => onSend(value)} />
          )
        ) : (
          <div aria-label="交流时间线" className="message-timeline" role="log">
            {opened.messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
          </div>
        )}
      </div>
      {blockedByHITL && <div className="composer-blocked">有一项写操作等待审批，请先处理后继续。</div>}
      <Composer
        activeFolderTitle={activeFolder?.title}
        attachmentsEnabled={attachmentsEnabled}
        context={context}
        disabled={blockedByHITL || opened.session.status === 'archived'}
        onSend={onSend}
        onStop={onStop}
        streaming={streaming}
        key={`composer:${opened.session.id}`}
      />
    </section>
  );
}

function SessionMenu({
  archived,
  onArchive,
  onDelete,
  streaming,
}: {
  archived: boolean;
  onArchive: () => void;
  onDelete: () => void;
  streaming: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="session-menu">
      <button
        aria-label="会话更多操作"
        className="icon-button"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <MoreHorizontal aria-hidden size={16} />
      </button>
      {open && (
        <div className="session-menu-popover">
          <button
            onClick={() => {
              const copy = navigator.clipboard?.writeText(window.location.href);
              if (copy) {
                void copy.catch(() => undefined);
              }
              setOpen(false);
            }}
            type="button"
          >
            <Clipboard aria-hidden size={13} /> 复制会话链接
          </button>
          <button
            disabled={streaming || archived}
            onClick={() => {
              onArchive();
              setOpen(false);
            }}
            type="button"
          >
            <Archive aria-hidden size={13} /> 归档会话
          </button>
          <button
            className="danger-action"
            disabled={streaming}
            onClick={() => {
              onDelete();
              setOpen(false);
            }}
            type="button"
          >
            <Trash2 aria-hidden size={13} /> 删除会话
          </button>
        </div>
      )}
    </div>
  );
}
