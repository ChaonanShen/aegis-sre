import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { CanvasPreview } from '../model';
import { CanvasStrip } from './CanvasStrip';

describe('CanvasStrip', () => {
  test.each([
    ['grid-2x2', '2 × 2'],
    ['grid-3x2', '3 × 2'],
    ['flex', '自适应'],
  ] as const)('exposes the %s canvas layout to the view', (layout, label) => {
    const chart = {
      id: 'chart-1',
      title: '请求速率',
      description: '固定窗口内的请求速率',
      visualization: 'line' as const,
      renderMode: 'fixture' as const,
    };
    const canvas: CanvasPreview = {
      visible: true,
      layout,
      charts: [chart, { ...chart, id: 'chart-2', title: '错误率' }],
    };

    render(<CanvasStrip canvas={canvas} editingEnabled={false} onChange={jest.fn()} />);

    expect(screen.getByTestId('session-canvas')).toHaveAttribute('data-layout', layout);
    expect(screen.getByText(`2 张图 · ${label}`)).toBeInTheDocument();
  });

  test('closes the fullscreen chart with Escape and restores the trigger focus', () => {
    const canvas: CanvasPreview = {
      visible: true,
      layout: 'grid-2x2',
      charts: [
        {
          id: 'chart-1',
          title: '请求速率',
          description: '固定窗口内的请求速率',
          visualization: 'line',
          renderMode: 'fixture',
        },
      ],
    };

    render(<CanvasStrip canvas={canvas} editingEnabled onChange={jest.fn()} />);
    const trigger = screen.getByRole('button', { name: '全屏 请求速率' });
    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole('dialog', { name: '请求速率 全屏预览' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('button', { name: '关闭全屏预览' })).toHaveAttribute('type', 'button');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '请求速率 全屏预览' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
