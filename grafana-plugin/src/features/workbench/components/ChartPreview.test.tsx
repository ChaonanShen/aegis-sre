import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { SavedChartPreview } from '../model';
import { ChartPreview } from './ChartPreview';

describe('ChartPreview fixtures', () => {
  test('renders a labelled multi-series time chart', () => {
    render(<ChartPreview chart={fixtureChart('chart-errors', '错误率（5xx）', 'line')} />);

    expect(screen.getByLabelText('错误率（5xx） 折线图预览')).toBeInTheDocument();
    const legend = screen.getByLabelText('图例');
    expect(within(legend).getByText('5xx')).toBeInTheDocument();
    expect(within(legend).getByText('基线')).toBeInTheDocument();
  });

  test('uses chart identity to label bar previews', () => {
    render(<ChartPreview chart={fixtureChart('chart-rate', '请求速率', 'bar')} />);

    expect(screen.getByLabelText('请求速率 柱状图预览')).toBeInTheDocument();
    expect(screen.getByText('1.84k/s')).toBeInTheDocument();
  });
});

function fixtureChart(id: string, title: string, visualization: SavedChartPreview['visualization']): SavedChartPreview {
  return {
    id,
    title,
    description: `${title} fixture`,
    visualization,
    renderMode: 'fixture',
  };
}
