import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { SavedChartPreview, WorkbenchMessage } from '../model';
import { CanvasStrip } from './CanvasStrip';
import { ChartQueryInfo } from './ChartQueryInfo';
import { MessageBubble } from './MessageBubble';

describe('ChartQueryInfo', () => {
  test('悬浮时显示持久化 PromQL 和绝对时间范围', async () => {
    const chart = chartWithQuery();
    render(<ChartQueryInfo chart={chart} />);

    const trigger = screen.getByRole('button', { name: '查看“Ceph 节点内存使用率”的 PromQL 与时间范围' });
    expect(screen.queryByText(chart.query!.spec.expression)).not.toBeInTheDocument();

    fireEvent.mouseEnter(trigger);

    expect(await screen.findByText('PromQL')).toBeInTheDocument();
    expect(screen.getByText(chart.query!.spec.expression)).toBeInTheDocument();
    expect(screen.getByText('绝对时间范围')).toBeInTheDocument();
    expect(screen.getByText('2026-07-30T01:16:31.000Z — 2026-07-30T01:46:31.000Z')).toBeInTheDocument();
  });

  test('没有持久化 Query 时不伪造信息入口', () => {
    const chart = chartWithQuery();
    delete chart.query;

    render(<ChartQueryInfo chart={chart} />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  test('只读画布保留查询与全屏入口，但隐藏布局编辑和删除', () => {
    const chart = chartWithQuery();
    render(
      <CanvasStrip
        canvas={{ visible: true, layout: 'grid-2x2', charts: [chart, { ...chart, id: 'chart-memory-2' }] }}
        editingEnabled={false}
        onChange={jest.fn()}
      />
    );

    expect(screen.getByRole('region', { name: '画布' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /PromQL 与时间范围/ })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: '全屏 Ceph 节点内存使用率' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: '编辑布局' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '删除 Ceph 节点内存使用率' })).not.toBeInTheDocument();
  });

  test('消息内图表也提供同一查询信息入口', () => {
    const chart = chartWithQuery();
    const message: WorkbenchMessage = {
      id: 'message-1',
      role: 'assistant',
      content: '已生成图表。',
      charts: [chart],
      streamStatus: 'complete',
    };

    render(<MessageBubble message={message} />);

    expect(
      screen.getByRole('button', { name: '查看“Ceph 节点内存使用率”的 PromQL 与时间范围' })
    ).toBeInTheDocument();
  });
});

function chartWithQuery(): SavedChartPreview {
  return {
    id: 'chart-memory',
    title: 'Ceph 节点内存使用率',
    description: '最近 30 分钟',
    visualization: 'line',
    renderMode: 'fixture',
    query: {
      id: 'query-memory',
      session_id: 'session-1',
      version: 1,
      spec: {
        datasource_uid: 'P43CA22E17D0F9596',
        expression: '(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100',
        range: {
          from: '2026-07-30T01:16:31.000Z',
          to: '2026-07-30T01:46:31.000Z',
          step_seconds: 30,
        },
      },
      created_at: '2026-07-30T01:46:31.000Z',
    },
  };
}
