import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  CoreApp,
  DataQueryError,
  DataQueryRequest,
  FieldConfigSource,
  LoadingState,
  PanelData,
  TimeRange,
  dateTime,
  toDataFrame,
} from '@grafana/data';
import { config, getDataSourceSrv, PanelRenderer } from '@grafana/runtime';
import { from, isObservable, Observable, shareReplay, Subscription } from 'rxjs';
import { SavedChartPreview } from '../model';

const supportedGrafanaMajor = 13;
const maxQueryDataPoints = 10_000;
const defaultFieldConfig: FieldConfigSource = { defaults: {}, overrides: [] };
const supportedPanelPlugins = new Set(['timeseries', 'stat', 'gauge', 'barchart']);

// PanelRenderer 在当前锁定的 @grafana/runtime 13.0.2 中仍标记为 @internal。
// 查询使用公开的 DataSourceApi；原生 panel 渲染目前没有无需引入 Scenes 的等价稳定入口。
// 因此这里只接受当前稳定的 Canvas v1 或 Grafana 13.x VizConfig，升级 Grafana 主版本时必须重新做 canary 验证。

interface QueryTargetTemplate {
  refId: string;
  spec: Record<string, unknown>;
}

interface PanelDefinition {
  datasourceUid: string;
  fieldConfig: FieldConfigSource;
  options: Record<string, unknown>;
  panelPluginId: string;
  range: TimeRange;
  rangeRaw: { from: string; to: string };
  stepSeconds: number;
  targets: QueryTargetTemplate[];
}

interface QueryExecutionDefinition {
  datasourceUid: string;
  range: TimeRange;
  rangeRaw: { from: string; to: string };
  stepSeconds: number;
  targets: QueryTargetTemplate[];
}

type PanelQueryState =
  | { status: 'loading'; data?: PanelData }
  | { status: 'ready'; data: PanelData }
  | { status: 'empty'; data: PanelData }
  | { status: 'error'; message: string };

interface SharedPanelQuery {
  observable: Observable<PanelQueryState>;
  references: number;
}

// 一张图可能同时出现在消息、画布和全屏视图中。查询结果只在仍有订阅者时共享；
// 最后一个视图卸载后立即取消查询并删除缓存，不把 DataFrame 写回会话。
const sharedPanelQueries = new Map<string, SharedPanelQuery>();

/** 使用持久化 Query 的绝对时间范围查询 Grafana 数据源，并按 VizConfig 原生渲染。 */
export function GrafanaPanelPreview({ chart }: { chart: SavedChartPreview }) {
  const parsed = useMemo(() => parsePanelDefinition(chart), [chart]);
  if (!parsed.ok) {
    return <DefinitionError chart={chart} message={parsed.error} />;
  }
  return <RenderablePanel chart={chart} definition={parsed.definition} />;
}

function RenderablePanel({ chart, definition }: { chart: SavedChartPreview; definition: PanelDefinition }) {
  const [retry, setRetry] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(containerRef);
  const state = usePanelQuery(definition, retry);

  if (state.status === 'error') {
    return (
      <DefinitionError chart={chart} message={state.message}>
        <button className="btn btn-ghost btn-sm" onClick={() => setRetry((value) => value + 1)} type="button">
          重新查询
        </button>
      </DefinitionError>
    );
  }

  return (
    <div className="grafana-panel-preview" data-testid={`grafana-panel-${chart.id}`} ref={containerRef}>
      {state.data && state.data.series.length > 0 ? (
        <PanelRenderBoundary chart={chart}>
          <PanelRenderer
            data={state.data}
            fieldConfig={definition.fieldConfig}
            height={Math.max(120, size.height)}
            options={definition.options}
            pluginId={definition.panelPluginId}
            timeZone="browser"
            title={chart.title}
            width={Math.max(240, size.width)}
          />
        </PanelRenderBoundary>
      ) : (
        <div className="chart-query-status" role="status">
          <strong>{state.status === 'empty' ? '查询完成，但没有数据' : '正在查询 Grafana 数据源'}</strong>
          <small>{formatRange(chart)}</small>
        </div>
      )}
      {(state.status === 'loading' || state.data?.state === LoadingState.Streaming) && state.data?.series.length ? (
        <span className="chart-query-badge">{state.data.state === LoadingState.Streaming ? '实时数据' : '查询中'}</span>
      ) : null}
    </div>
  );
}

class PanelRenderBoundary extends React.Component<
  React.PropsWithChildren<{ chart: SavedChartPreview }>,
  { message?: string }
> {
  state: { message?: string } = {};

  static getDerivedStateFromError(error: unknown): { message: string } {
    return { message: describeUnknownError(error, 'Grafana 图表插件加载或渲染失败。') };
  }

  render() {
    if (this.state.message) {
      return <DefinitionError chart={this.props.chart} message={this.state.message} />;
    }
    return this.props.children;
  }
}

function usePanelQuery(definition: PanelDefinition, retry: number): PanelQueryState {
  const [state, setState] = useState<PanelQueryState>({ status: 'loading' });
  const queryKey = normalizedQueryKey(definition);

  useEffect(() => {
    const shared = acquireSharedPanelQuery(queryKey, retry);
    const subscription = shared.observable.subscribe(setState);
    return () => {
      subscription.unsubscribe();
      shared.release();
    };
  }, [queryKey, retry]);

  return state;
}

function acquireSharedPanelQuery(
  queryKey: string,
  retry: number
): { observable: Observable<PanelQueryState>; release: () => void } {
  const key = `${queryKey}#${retry}`;
  let shared = sharedPanelQueries.get(key);
  if (!shared) {
    shared = {
      observable: executePanelQuery(queryDefinitionFromKey(queryKey)).pipe(
        shareReplay({ bufferSize: 1, refCount: true })
      ),
      references: 0,
    };
    sharedPanelQueries.set(key, shared);
  }
  shared.references++;
  let released = false;
  return {
    observable: shared.observable,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      shared.references--;
      if (shared.references === 0 && sharedPanelQueries.get(key) === shared) {
        sharedPanelQueries.delete(key);
      }
    },
  };
}

function executePanelQuery(definition: QueryExecutionDefinition): Observable<PanelQueryState> {
  return new Observable((subscriber) => {
    let disposed = false;
    let responseSubscription: Subscription | undefined;
    let structureRev = 0;
    const keyedSeries = new Map<string, PanelData['series']>();

    subscriber.next({ status: 'loading' });
    void (async () => {
      try {
        const datasource = await getDataSourceSrv().get({ uid: definition.datasourceUid });
        if (disposed) {
          return;
        }
        const request = buildQueryRequest(definition, datasource.type);
        subscriber.next({ status: 'loading', data: emptyPanelData(request, definition.range) });

        const result = datasource.query(request);
        const responses = isObservable(result) ? result : from(result);
        responseSubscription = responses.subscribe({
          next: (response) => {
            if (disposed) {
              return;
            }
            try {
              const responseSeries = response.data.map((frame) => toDataFrame(frame));
              let series = responseSeries;
              if (response.key) {
                keyedSeries.set(response.key, responseSeries);
                series = Array.from(keyedSeries.values()).flat();
              } else {
                keyedSeries.clear();
              }
              const errors = response.errors;
              const data: PanelData = {
                state: response.state ?? (errors?.length ? LoadingState.Error : LoadingState.Done),
                series,
                structureRev: ++structureRev,
                request,
                timeRange: definition.range,
                errors,
                traceIds: response.traceIds,
              };
              if (data.state === LoadingState.Error || (errors?.length && series.length === 0)) {
                subscriber.next({ status: 'error', message: describeQueryErrors(errors) });
              } else if (data.state === LoadingState.Done && series.length === 0) {
                subscriber.next({ status: 'empty', data });
              } else {
                subscriber.next({ status: data.state === LoadingState.Done ? 'ready' : 'loading', data });
              }
            } catch (error) {
              subscriber.next({ status: 'error', message: describeUnknownError(error) });
            }
          },
          error: (error) => {
            if (!disposed) {
              subscriber.next({ status: 'error', message: describeUnknownError(error) });
              subscriber.complete();
            }
          },
          complete: () => subscriber.complete(),
        });
      } catch (error) {
        if (!disposed) {
          subscriber.next({ status: 'error', message: describeUnknownError(error) });
          subscriber.complete();
        }
      }
    })();

    return () => {
      disposed = true;
      responseSubscription?.unsubscribe();
    };
  });
}

export function parsePanelDefinition(
  chart: SavedChartPreview
): { ok: true; definition: PanelDefinition } | { ok: false; error: string } {
  if (!chart.query) {
    return { ok: false, error: '图表缺少可恢复的 Query 定义，无法查询数据。' };
  }
  if (!chart.query.spec.datasource_uid.trim() || !chart.query.spec.expression.trim()) {
    return { ok: false, error: 'Query 缺少数据源 UID 或查询表达式。' };
  }

  const runtimeVersion = config.buildInfo.version;
  if (majorVersion(runtimeVersion) !== supportedGrafanaMajor) {
    return { ok: false, error: `当前预览仅支持 Grafana 13.x，实际运行版本是 ${runtimeVersion || '未知'}。` };
  }

  const range = parseAbsoluteRange(chart.query.spec.range.from, chart.query.spec.range.to);
  if (!range) {
    return { ok: false, error: 'Query 的绝对时间范围无效。' };
  }
  const stepSeconds = chart.query.spec.range.step_seconds;
  if (!Number.isSafeInteger(stepSeconds) || stepSeconds <= 0) {
    return { ok: false, error: 'Query 的 step_seconds 必须是正整数。' };
  }
  if (stepSeconds * 1000 > range.value.to.valueOf() - range.value.from.valueOf()) {
    return { ok: false, error: 'Query 的 step_seconds 不能大于绝对时间窗口。' };
  }
  const dataPoints = queryDataPoints(range.value, stepSeconds);
  if (dataPoints === undefined || dataPoints > maxQueryDataPoints) {
    return { ok: false, error: `Query 最多允许 ${maxQueryDataPoints.toLocaleString()} 个数据点。` };
  }

  const persistedRecord = asRecord(chart.vizConfig);
  const emptyVizConfig = persistedRecord && Object.keys(persistedRecord).length === 0;
  const persistedVizConfig =
    chart.vizConfig === undefined || emptyVizConfig ? undefined : supportedVizConfig(chart.vizConfig);
  if (chart.vizConfig !== undefined && !emptyVizConfig && !persistedVizConfig) {
    return { ok: false, error: '持久化 Chart.Spec 不是受支持的 Canvas/Grafana VizConfig。' };
  }

  return {
    ok: true,
    definition: {
      datasourceUid: chart.query.spec.datasource_uid,
      fieldConfig: persistedVizConfig?.fieldConfig ?? defaultFieldConfig,
      options: persistedVizConfig?.options ?? {},
      panelPluginId: persistedVizConfig?.pluginId ?? fallbackPanelPlugin(chart.visualization),
      range: range.value,
      rangeRaw: range.raw,
      stepSeconds,
      targets: [
        {
          refId: 'A',
          spec: {
            editorMode: 'code',
            expr: chart.query.spec.expression,
            legendFormat: '__auto',
            range: true,
          },
        },
      ],
    },
  };
}

function supportedVizConfig(
  value: unknown
): { pluginId: string; options: Record<string, unknown>; fieldConfig: FieldConfigSource } | undefined {
  const vizConfig = asRecord(value);
  const spec = asRecord(vizConfig?.spec);
  if (
    vizConfig?.kind !== 'VizConfig' ||
    typeof vizConfig.group !== 'string' ||
    !supportedPanelPlugins.has(vizConfig.group) ||
    typeof vizConfig.version !== 'string' ||
    !supportedVizConfigVersion(vizConfig.version) ||
    !spec ||
    !asRecord(spec.options) ||
    !isFieldConfig(spec.fieldConfig)
  ) {
    return undefined;
  }
  return {
    pluginId: vizConfig.group,
    options: spec.options as Record<string, unknown>,
    fieldConfig: spec.fieldConfig as FieldConfigSource,
  };
}

function supportedVizConfigVersion(version: string): boolean {
  return version === 'v1' || majorVersion(version) === supportedGrafanaMajor;
}

function fallbackPanelPlugin(visualization: SavedChartPreview['visualization']): string {
  return visualization === 'line' ? 'timeseries' : visualization === 'bar' ? 'barchart' : visualization;
}

function normalizedQueryKey(definition: PanelDefinition): string {
  return JSON.stringify(
    canonicalJSON({
      datasourceUid: definition.datasourceUid,
      from: definition.range.from.valueOf(),
      rangeRaw: definition.rangeRaw,
      stepSeconds: definition.stepSeconds,
      targets: definition.targets,
      to: definition.range.to.valueOf(),
    })
  );
}

function queryDefinitionFromKey(key: string): QueryExecutionDefinition {
  const value = JSON.parse(key) as {
    datasourceUid: string;
    from: number;
    rangeRaw: { from: string; to: string };
    stepSeconds: number;
    targets: QueryTargetTemplate[];
    to: number;
  };
  return {
    datasourceUid: value.datasourceUid,
    range: { from: dateTime(value.from), to: dateTime(value.to), raw: value.rangeRaw },
    rangeRaw: value.rangeRaw,
    stepSeconds: value.stepSeconds,
    targets: value.targets,
  };
}

function canonicalJSON(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalJSON);
  }
  const record = asRecord(value);
  if (record) {
    return Object.fromEntries(
      Object.entries(record)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalJSON(item)])
    );
  }
  return value;
}

function emptyPanelData(request: DataQueryRequest, range: TimeRange): PanelData {
  return { state: LoadingState.Loading, series: [], request, timeRange: range };
}

function buildQueryRequest(definition: QueryExecutionDefinition, datasourceType: string): DataQueryRequest {
  const intervalMs = definition.stepSeconds * 1000;
  const maxDataPoints = queryDataPoints(definition.range, definition.stepSeconds);
  if (maxDataPoints === undefined || maxDataPoints > maxQueryDataPoints) {
    throw new Error(`Query 最多允许 ${maxQueryDataPoints.toLocaleString()} 个数据点。`);
  }
  return {
    requestId: `torchbearing-${Date.now()}`,
    interval: `${definition.stepSeconds}s`,
    intervalMs,
    maxDataPoints,
    range: definition.range,
    rangeRaw: definition.rangeRaw,
    scopedVars: {},
    targets: definition.targets.map(({ refId, spec }) => ({
      ...spec,
      datasource: { type: datasourceType, uid: definition.datasourceUid },
      hide: false,
      refId,
    })),
    timezone: 'browser',
    app: CoreApp.PanelViewer,
    startTime: Date.now(),
  };
}

function parseAbsoluteRange(
  from: string,
  to: string
): { value: TimeRange; raw: { from: string; to: string } } | undefined {
  const fromMillis = absoluteMillis(from);
  const toMillis = absoluteMillis(to);
  if (fromMillis === undefined || toMillis === undefined || fromMillis >= toMillis) {
    return undefined;
  }
  return {
    value: { from: dateTime(fromMillis), to: dateTime(toMillis), raw: { from, to } },
    raw: { from, to },
  };
}

function absoluteMillis(value: string): number | undefined {
  const trimmed = value.trim();
  const numeric = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  const millis = Number.isFinite(numeric) ? numeric : Date.parse(trimmed);
  return Number.isSafeInteger(millis) ? millis : undefined;
}

function queryDataPoints(range: TimeRange, stepSeconds: number): number | undefined {
  const intervalMs = stepSeconds * 1000;
  const rangeMs = range.to.valueOf() - range.from.valueOf();
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0 || !Number.isSafeInteger(rangeMs) || rangeMs <= 0) {
    return undefined;
  }
  return Math.ceil(rangeMs / intervalMs) + 1;
}

function majorVersion(version: string | undefined): number | undefined {
  const match = /^(\d+)\./.exec(version ?? '');
  return match ? Number(match[1]) : undefined;
}

function isFieldConfig(value: unknown): boolean {
  const fieldConfig = asRecord(value);
  return Boolean(fieldConfig && asRecord(fieldConfig.defaults) && Array.isArray(fieldConfig.overrides));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function describeQueryErrors(errors: DataQueryError[] | undefined): string {
  const messages = errors?.map((error) => error.message ?? error.data?.message).filter(Boolean);
  return messages?.length ? messages.join('；') : 'Grafana 数据源查询失败。';
}

function describeUnknownError(error: unknown, fallback = 'Grafana 数据源查询失败。'): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function DefinitionError({
  chart,
  message,
  children,
}: React.PropsWithChildren<{ chart: SavedChartPreview; message: string }>) {
  return (
    <div className="chart-definition chart-definition-error" data-testid={`chart-definition-${chart.id}`} role="alert">
      <strong>图表暂时无法渲染</strong>
      <span>{message}</span>
      {chart.query ? <code title={chart.query.spec.expression}>{chart.query.spec.expression}</code> : null}
      {children}
    </div>
  );
}

function formatRange(chart: SavedChartPreview): string {
  const range = chart.query?.spec.range;
  return range ? `${formatTime(range.from)} — ${formatTime(range.to)}` : '';
}

function formatTime(value: string): string {
  const parsed = new Date(absoluteMillis(value) ?? Number.NaN);
  return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleString();
}

function useElementSize(ref: React.RefObject<HTMLElement>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 400, height: 160 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const measure = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setSize({ width: Math.floor(rect.width), height: Math.floor(rect.height) });
      }
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}
