import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { ContextPane } from './ContextPane';

describe('ContextPane', () => {
  test('explains the idle state before a Folder is selected', () => {
    render(<ContextPane context={{ status: 'idle' }} onClose={jest.fn()} onRetry={jest.fn()} />);

    expect(screen.getByText('选择 Folder 后可查看调查上下文。')).toBeInTheDocument();
  });

  test('shows the gateway error and retries', () => {
    const onRetry = jest.fn();
    render(
      <ContextPane
        context={{ status: 'error', error: new Error('Folder 权限已失效') }}
        onClose={jest.fn()}
        onRetry={onRetry}
      />
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Folder 权限已失效');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
