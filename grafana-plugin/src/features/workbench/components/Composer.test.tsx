import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { Composer } from './Composer';

describe('Composer', () => {
  test('does not send when Enter confirms an IME composition', () => {
    const onSend = jest.fn();
    renderComposer(onSend);
    const input = screen.getByRole('textbox', { name: '消息输入' });

    fireEvent.change(input, { target: { value: '你好' } });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });

    expect(onSend).not.toHaveBeenCalled();
    expect(input).toHaveValue('你好');

    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(onSend).toHaveBeenCalledWith('你好', []);
    expect(input).toHaveValue('');
  });

  test('does not send an IME compatibility Enter event with keyCode 229', () => {
    const onSend = jest.fn();
    renderComposer(onSend);
    const input = screen.getByRole('textbox', { name: '消息输入' });

    fireEvent.change(input, { target: { value: '候选词' } });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });

    expect(onSend).not.toHaveBeenCalled();
    expect(input).toHaveValue('候选词');
  });

  test('keeps Shift+Enter as a newline action', () => {
    const onSend = jest.fn();
    renderComposer(onSend);
    const input = screen.getByRole('textbox', { name: '消息输入' });

    fireEvent.change(input, { target: { value: '第一行' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });

    expect(onSend).not.toHaveBeenCalled();
  });

  test('remains usable without claiming Folder mention context', () => {
    render(
      <Composer
        attachmentsEnabled={false}
        disabled={false}
        onSend={jest.fn()}
        onStop={jest.fn()}
        streaming={false}
      />
    );

    expect(screen.getByRole('textbox', { name: '消息输入' })).toHaveAttribute(
      'placeholder',
      '描述现象、时间范围或目标'
    );
    expect(screen.getByRole('textbox', { name: '消息输入' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '@ 提及' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '添加附件' })).not.toBeInTheDocument();
  });

  test('shows the attachment entry only when the capability is enabled', () => {
    renderComposer(jest.fn());

    expect(screen.getByRole('button', { name: '添加附件' })).toBeInTheDocument();
  });
});

function renderComposer(onSend: jest.Mock) {
  return render(
    <Composer
      activeFolderTitle="Infra"
      attachmentsEnabled
      disabled={false}
      onSend={onSend}
      onStop={jest.fn()}
      streaming={false}
    />
  );
}
