import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { OpenedSession } from '../model';
import { ChatPane } from './ChatPane';

describe('ChatPane', () => {
  test('disables archive while the assistant is streaming', () => {
    const onArchive = jest.fn();
    render(
      <ChatPane
        attachmentsEnabled={false}
        blockedByHITL={false}
        contextOpen={false}
        historyOpen={true}
        onArchive={onArchive}
        onDelete={jest.fn()}
        onSend={jest.fn()}
        onStop={jest.fn()}
        onToggleContext={jest.fn()}
        onToggleHistory={jest.fn()}
        opened={openedSession}
        streaming={true}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: '会话更多操作' }));
    const archive = screen.getByRole('button', { name: '归档会话' });
    expect(archive).toBeDisabled();

    fireEvent.click(archive);
    expect(onArchive).not.toHaveBeenCalled();
  });

  test('resets transient composer and menu state when the session changes', () => {
    const view = render(
      <ChatPane
        attachmentsEnabled={false}
        blockedByHITL={false}
        contextOpen={false}
        historyOpen={true}
        onArchive={jest.fn()}
        onDelete={jest.fn()}
        onSend={jest.fn()}
        onStop={jest.fn()}
        onToggleContext={jest.fn()}
        onToggleHistory={jest.fn()}
        opened={openedSession}
        streaming={false}
      />
    );

    fireEvent.change(screen.getByRole('textbox', { name: '消息输入' }), { target: { value: '旧会话草稿' } });
    fireEvent.click(screen.getByRole('button', { name: '会话更多操作' }));
    expect(screen.getByRole('button', { name: '复制会话链接' })).toBeInTheDocument();

    view.rerender(
      <ChatPane
        attachmentsEnabled={false}
        blockedByHITL={false}
        contextOpen={false}
        historyOpen={true}
        onArchive={jest.fn()}
        onDelete={jest.fn()}
        onSend={jest.fn()}
        onStop={jest.fn()}
        onToggleContext={jest.fn()}
        onToggleHistory={jest.fn()}
        opened={{ ...openedSession, session: { ...openedSession.session, id: 'session-2', title: '新会话' } }}
        streaming={false}
      />
    );

    expect(screen.getByRole('textbox', { name: '消息输入' })).toHaveValue('');
    expect(screen.queryByRole('button', { name: '复制会话链接' })).not.toBeInTheDocument();
  });

  test('does not offer quick actions for an archived empty session', () => {
    const onSend = jest.fn();
    render(
      <ChatPane
        attachmentsEnabled={false}
        blockedByHITL={false}
        contextOpen={false}
        historyOpen={true}
        onArchive={jest.fn()}
        onDelete={jest.fn()}
        onSend={onSend}
        onStop={jest.fn()}
        onToggleContext={jest.fn()}
        onToggleHistory={jest.fn()}
        opened={{ ...openedSession, session: { ...openedSession.session, status: 'archived' } }}
        streaming={false}
      />
    );

    expect(screen.getByRole('status')).toHaveTextContent('此会话已归档');
    expect(screen.queryByRole('button', { name: /@checkout-api/ })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '消息输入' })).toBeDisabled();
    expect(onSend).not.toHaveBeenCalled();
  });
});

const openedSession: OpenedSession = {
  session: {
    id: 'session-1',
    title: 'CPU 排查',
    folderUid: '',
    folderTitle: '未绑定',
    status: 'active',
    visibility: 'private',
    updatedAt: '2026-07-31T08:00:00Z',
    messageCount: 0,
    preview: '',
  },
  messages: [],
  canvas: { visible: true, layout: 'grid-2x2', charts: [] },
};
