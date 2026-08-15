import React from 'react';
import { DataQueryRequest, FieldType, LoadingState, toDataFrame } from '@grafana/data';
import { getDataSourceSrv, PanelRenderer, PanelRendererProps } from '@grafana/runtime';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Observable, of, throwError } from 'rxjs';
import { SavedChartPreview } from '../model';
import { ChartPreview } from './ChartPreview';

jest.mock('@grafana/runtime', () => ({
  config: { buildInfo: { version: '13.1.0' } },
  getDataSourceSrv: jest.fn(),
  PanelRenderer: jest.fn(() => null),
}));

const mockedGetDataSourceSrv = jest.mocked(getDataSourceSrv);
const mockedPanelRenderer = PanelRenderer as unknown as jest.Mock;

describe('GrafanaPanelPreview', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('使用 Query 的绝对时间范围查询，并用 VizConfig 渲染原生图表', async () => {
    const frame = toDataFrame({
      refId: 'A',
      fields: [
        { name: 'Time', type: FieldType.time, values: [1784714950000, 1784714965000] },
        { name: 'Value', type: FieldType.number, values: [1, 2] },
      ],
    });
    const query = jest.fn((_request: DataQueryRequest) => of({ data: [frame], state: LoadingState.Done }));
    const get = jest.fn(async () => ({ type: 'prometheus', query }));
    mockedGetDataSourceSrv.mockReturnValue({ get } as unknown as ReturnType<typeof getDataSourceSrv>);

    render(<ChartPreview chart={definitionChart()} />);

    await waitFor(() => expect(mockedPanelRenderer).toHaveBeenCalled());
    expect(get).toHaveBeenCalledWith({ uid: 'prom-main' });
    const request = query.mock.calls[0][0];
    expect(request.range.from.valueOf()).toBe(Date.parse('2026-07-22T10:09:10.000Z'));
    expect(request.range.to.valueOf()).toBe(Date.parse('2026-07-22T10:39:10.000Z'));
    expect(request.intervalMs).toBe(15_000);
    expect(request.targets).toEqual([
      expect.objectContaining({
        datasource: { type: 'prometheus', uid: 'prom-main' },
        expr: 'rate(http_requests_total[5m])',
        hide: false,
        refId: 'A',
      }),
    ]);
    const rendererProps = mockedPanelRenderer.mock.calls.at(-1)?.[0] as PanelRendererProps;
    expect(rendererProps).toEqual(
      expect.objectContaining({
        pluginId: 'timeseries',
        data: expect.objectContaining({ state: LoadingState.Done, series: [frame] }),
        options: expect.objectContaining({ legend: expect.objectContaining({ displayMode: 'table' }) }),
        fieldConfig: expect.objectContaining({ defaults: expect.objectContaining({ decimals: 4 }) }),
      })
    );
  });

  test('兼容 Canvas v1 VizConfig 并使用 Grafana 原生渲染器', async () => {
    const frame = toDataFrame({
      refId: 'A',
      fields: [
        { name: 'Time', type: FieldType.time, values: [1784714950000, 1784714965000] },
        { name: 'Value', type: FieldType.number, values: [1, 2] },
      ],
    });
    const query = jest.fn((_request: DataQueryRequest) => of({ data: [frame], state: LoadingState.Done }));
    mockedGetDataSourceSrv.mockReturnValue({
      get: jest.fn(async () => ({ type: 'prometheus', query })),
    } as unknown as ReturnType<typeof getDataSourceSrv>);
    const chart = definitionChart();
    chart.vizConfig = { ...(chart.vizConfig as Record<string, unknown>), version: 'v1' };

    render(<ChartPreview chart={chart} />);

    await waitFor(() => expect(mockedPanelRenderer).toHaveBeenCalled());
    expect(mockedPanelRenderer.mock.calls.at(-1)?.[0]).toEqual(expect.objectContaining({ pluginId: 'timeseries' }));
  });

  test('显式 fixture 图表仍使用本地预览，不会查询数据源', () => {
    const get = jest.fn();
    mockedGetDataSourceSrv.mockReturnValue({ get } as unknown as ReturnType<typeof getDataSourceSrv>);

    render(<ChartPreview chart={fixtureChart()} />);

    expect(screen.getByLabelText(/折线图预览/)).toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
    expect(mockedPanelRenderer).not.toHaveBeenCalled();
  });

  test('消息与画布中的等值图表共享查询，最后一个卸载时取消', async () => {
    const teardown = jest.fn();
    const query = jest.fn(
      (_request: DataQueryRequest) =>
        new Observable((subscriber) => {
          subscriber.next({ data: [], state: LoadingState.Streaming });
          return teardown;
        })
    );
    mockedGetDataSourceSrv.mockReturnValue({
      get: jest.fn(async () => ({ type: 'prometheus', query })),
    } as unknown as ReturnType<typeof getDataSourceSrv>);

    const first = render(<ChartPreview chart={definitionChart()} />);
    const second = render(<ChartPreview chart={definitionChart()} />);
    await waitFor(() => expect(query).toHaveBeenCalledTimes(1));

    first.unmount();
    expect(teardown).not.toHaveBeenCalled();
    second.unmount();
    expect(teardown).toHaveBeenCalledTimes(1);
  });

  test('同一毫秒恢复多张图时为每条查询生成唯一 requestId', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_786_788_206_818);
    const query = jest.fn((_request: DataQueryRequest) => of({ data: [], state: LoadingState.Done }));
    mockedGetDataSourceSrv.mockReturnValue({
      get: jest.fn(async () => ({ type: 'prometheus', query })),
    } as unknown as ReturnType<typeof getDataSourceSrv>);
    const charts = Array.from({ length: 6 }, (_, index) => {
      const chart = definitionChart();
      chart.id = `chart-${index}`;
      chart.query = {
        ...chart.query!,
        id: `query-${index}`,
        spec: {
          ...chart.query!.spec,
          expression: `rate(http_requests_total{instance=\"node-${index}\"}[5m])`,
        },
      };
      return chart;
    });

    render(
      <>
        {charts.map((chart) => (
          <ChartPreview chart={chart} key={chart.id} />
        ))}
      </>
    );

    await waitFor(() => expect(query).toHaveBeenCalledTimes(6));
    const requestIds = query.mock.calls.map(([request]) => request.requestId);
    expect(new Set(requestIds).size).toBe(6);
  });

  test('数据源失败时显示原因，并允许重新查询', async () => {
    const query = jest
      .fn((_request: DataQueryRequest) => of({ data: [], state: LoadingState.Done }))
      .mockImplementationOnce(() => throwError(() => new Error('Prometheus 暂时不可用')));
    mockedGetDataSourceSrv.mockReturnValue({
      get: jest.fn(async () => ({ type: 'prometheus', query })),
    } as unknown as ReturnType<typeof getDataSourceSrv>);

    render(<ChartPreview chart={definitionChart()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Prometheus 暂时不可用');

    fireEvent.click(screen.getByRole('button', { name: '重新查询' }));

    expect(await screen.findByText('查询完成，但没有数据')).toBeInTheDocument();
    expect(query).toHaveBeenCalledTimes(2);
  });

  test('缺少 Query 时显示可理解状态，不会退回 fixture 曲线', () => {
    const get = jest.fn();
    mockedGetDataSourceSrv.mockReturnValue({ get } as unknown as ReturnType<typeof getDataSourceSrv>);
    const chart = definitionChart();
    delete chart.query;

    render(<ChartPreview chart={chart} />);

    expect(screen.getByRole('alert')).toHaveTextContent('图表缺少可恢复的 Query 定义');
    expect(screen.queryByLabelText('折线图预览')).not.toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });

  test('拒绝会造成过量数据点的持久化查询', () => {
    const get = jest.fn();
    mockedGetDataSourceSrv.mockReturnValue({ get } as unknown as ReturnType<typeof getDataSourceSrv>);
    const chart = definitionChart();
    chart.query!.spec.range.to = '2026-07-24T03:49:10.000Z';

    render(<ChartPreview chart={chart} />);

    expect(screen.getByRole('alert')).toHaveTextContent('Query 最多允许 10,000 个数据点');
    expect(get).not.toHaveBeenCalled();
  });
});

function definitionChart(): SavedChartPreview {
  return {
    id: 'chart-1',
    title: '请求速率',
    description: '固定窗口内的请求速率',
    visualization: 'line',
    renderMode: 'definition',
    vizConfig: {
      kind: 'VizConfig',
      group: 'timeseries',
      version: '13.1.0',
      spec: {
        options: {
          legend: { displayMode: 'table', placement: 'bottom', showLegend: true, calcs: ['lastNotNull'] },
        },
        fieldConfig: { defaults: { custom: {}, decimals: 4 }, overrides: [] },
      },
    },
    query: {
      id: 'query-1',
      session_id: 'session-1',
      version: 1,
      spec: {
        datasource_uid: 'prom-main',
        expression: 'rate(http_requests_total[5m])',
        range: {
          from: '2026-07-22T10:09:10.000Z',
          to: '2026-07-22T10:39:10.000Z',
          step_seconds: 15,
        },
      },
      created_at: '2026-07-22T10:39:10.000Z',
    },
  };
}

function fixtureChart(): SavedChartPreview {
  return {
    id: 'fixture-chart',
    title: 'Fixture 图表',
    description: '',
    visualization: 'line',
    renderMode: 'fixture',
  };
}
