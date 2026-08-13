import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { ToolCall } from '../model';
import { ToolCallCard } from './ToolCallCard';

describe('ToolCallCard', () => {
  test('starts successful calls collapsed and keeps the user choice after a rerender', () => {
    const toolCall = createToolCall({ status: 'ok', durationMs: 42 });
    const { rerender } = render(<ToolCallCard toolCall={toolCall} />);
    const details = screen.getByTestId('tool-call-tool-1');

    expect(details).not.toHaveAttribute('open');
    fireEvent.click(screen.getByText('metrics.query'));
    expect(details).toHaveAttribute('open');

    rerender(<ToolCallCard toolCall={{ ...toolCall, durationMs: 84 }} />);
    expect(details).toHaveAttribute('open');
  });

  test('starts pending and failed calls expanded', () => {
    const { rerender } = render(<ToolCallCard toolCall={createToolCall({ status: 'pending' })} />);

    expect(screen.getByTestId('tool-call-tool-1')).toHaveAttribute('open');
    rerender(<ToolCallCard key="failed" toolCall={createToolCall({ status: 'err' })} />);
    expect(screen.getByTestId('tool-call-tool-1')).toHaveAttribute('open');
  });
});

function createToolCall(overrides: Partial<ToolCall>): ToolCall {
  return {
    id: 'tool-1',
    server: 'metrics',
    tool: 'query',
    tier: 'read',
    args: '{}',
    status: 'ok',
    ...overrides,
  };
}
