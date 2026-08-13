import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { useDialogA11y } from './useDialogA11y';

function Dialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useDialogA11y<HTMLDivElement>(onClose);
  return (
    <div aria-label="测试对话框" aria-modal="true" ref={dialogRef} role="dialog">
      <button onClick={onClose} type="button">
        关闭
      </button>
      <button type="button">第二个操作</button>
    </div>
  );
}

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)} type="button">
        打开
      </button>
      {open && <Dialog onClose={() => setOpen(false)} />}
    </>
  );
}

describe('useDialogA11y', () => {
  test('moves focus into the dialog, traps Tab, and restores focus after Escape', () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: '打开' });
    trigger.focus();
    fireEvent.click(trigger);

    const close = screen.getByRole('button', { name: '关闭' });
    const second = screen.getByRole('button', { name: '第二个操作' });
    expect(close).toHaveFocus();

    second.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(second).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
