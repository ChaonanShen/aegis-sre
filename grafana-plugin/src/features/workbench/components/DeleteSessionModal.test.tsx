import React, { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DeleteSessionModal } from './DeleteSessionModal';

describe('DeleteSessionModal', () => {
  test('preserves autoFocus, traps focus, and restores the opener after Escape', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)} type="button">
            打开删除确认
          </button>
          <DeleteSessionModal
            deleting={false}
            onClose={() => setOpen(false)}
            onConfirm={() => undefined}
            open={open}
            sessionTitle="Checkout 排查"
          />
        </>
      );
    }

    render(<Harness />);
    const opener = screen.getByRole('button', { name: '打开删除确认' });
    opener.focus();
    fireEvent.click(opener);

    const dialog = await screen.findByRole('dialog', { name: '删除会话' });
    const cancel = within(dialog).getByRole('button', { name: '取消' });
    const confirm = within(dialog).getByRole('button', { name: '删除会话' });
    expect(cancel).toHaveFocus();

    confirm.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(within(dialog).getByRole('button', { name: '关闭删除确认' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '删除会话' })).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  test('does not close while deletion is in flight', () => {
    function Harness() {
      const [open, setOpen] = useState(true);
      const [deleting, setDeleting] = useState(false);
      return (
        <DeleteSessionModal
          deleting={deleting}
          onClose={() => setOpen(false)}
          onConfirm={() => setDeleting(true)}
          open={open}
          sessionTitle="Checkout 排查"
        />
      );
    }

    render(<Harness />);
    const dialog = screen.getByRole('dialog', { name: '删除会话' });
    fireEvent.click(within(dialog).getByRole('button', { name: '删除会话' }));
    expect(within(dialog).getByRole('button', { name: '关闭删除确认' })).toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: '删除会话' })).toBeInTheDocument();
  });
});
