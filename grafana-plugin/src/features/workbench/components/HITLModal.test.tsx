import React, { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HITLModal } from './HITLModal';

describe('HITLModal', () => {
  test('keeps an unverified request visible while locking approval', () => {
    render(
      <HITLModal
        folder={undefined}
        onApprove={jest.fn()}
        onClose={jest.fn()}
        onReject={jest.fn()}
        open
        request={{
          id: 'checkpoint-1',
          clientTurnId: 'turn-1',
          toolCallId: 'call-1',
          server: 'agent',
          tool: 'approval',
          args: '{}',
          preview: ['+ panel'],
          reason: '写操作需要审批',
        }}
      />
    );

    expect(screen.getByRole('dialog', { name: '写操作需审批' })).toBeInTheDocument();
    expect(screen.getByText('暂时无法验证 Folder 权限，审批操作已锁定。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '批准执行' })).toBeDisabled();
  });

  test('closes on Escape and restores focus to the opener', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)} type="button">
            打开审批
          </button>
          <HITLModal
            folder={undefined}
            onApprove={jest.fn()}
            onClose={() => setOpen(false)}
            onReject={jest.fn()}
            open={open}
            request={{
              id: 'checkpoint-2',
              clientTurnId: 'turn-2',
              toolCallId: 'call-2',
              server: 'agent',
              tool: 'approval',
              args: '{}',
              preview: ['+ panel'],
              reason: '写操作需要审批',
            }}
          />
        </>
      );
    }

    render(<Harness />);
    const opener = screen.getByRole('button', { name: '打开审批' });
    opener.focus();
    fireEvent.click(opener);

    expect(await screen.findByRole('dialog', { name: '写操作需审批' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog', { name: '写操作需审批' })).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });
});
