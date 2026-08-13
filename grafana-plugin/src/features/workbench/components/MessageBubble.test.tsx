import React from 'react';
import { render, screen } from '@testing-library/react';
import { WorkbenchMessage } from '../model';
import { MessageBubble } from './MessageBubble';

describe('MessageBubble', () => {
  test('renders assistant messages as sanitized Markdown', () => {
    const { container } = render(
      <MessageBubble
        message={message(
          'assistant',
          '## 分析结果\n\n- **CPU** 升高\n- `rate(cpu_total[5m])`\n\n<script>alert(1)</script>'
        )}
      />
    );

    expect(screen.getByRole('heading', { level: 2, name: '分析结果' })).toBeInTheDocument();
    expect(screen.getByText('CPU').tagName).toBe('STRONG');
    expect(screen.getByText('rate(cpu_total[5m])').tagName).toBe('CODE');
    expect(container.querySelector('script')).not.toBeInTheDocument();
  });

  test('keeps user messages as literal text', () => {
    render(<MessageBubble message={message('user', '请查询 **CPU**，不要把它当标题')} />);

    expect(screen.getByText('请查询 **CPU**，不要把它当标题')).toBeInTheDocument();
    expect(screen.queryByText('CPU', { selector: 'strong' })).not.toBeInTheDocument();
  });
});

function message(role: 'user' | 'assistant', content: string): WorkbenchMessage {
  return {
    id: `${role}-message`,
    role,
    content,
    streamStatus: 'complete',
  };
}
