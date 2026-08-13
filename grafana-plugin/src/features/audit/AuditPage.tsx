import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Download, Filter, Search, ShieldCheck, XCircle } from 'lucide-react';
import { useAppServices } from '../../app/AppServices';
import { auditEventTypes } from './fixtures/auditFixtures';
import { AuditEvent, AuditEventType, AuditOutcome, AuditQuery, AuditQueryResult, AuditTimeRange } from './model';
import './audit.css';

export default function AuditPage() {
  const { auditGateway } = useAppServices();
  const [query, setQuery] = useState<AuditQuery>({ timeRange: 'today' });
  const [result, setResult] = useState<AuditQueryResult>();
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(true);
  const requestRef = useRef(0);
  const exportRequestRef = useRef(0);
  const exportControllerRef = useRef<AbortController>();
  const exportingRef = useRef(false);
  const mountedRef = useRef(true);
  const load = useCallback(
    async (nextQuery: AuditQuery, signal?: AbortSignal) => {
      const request = ++requestRef.current;
      try {
        const next = await auditGateway.queryAudit(nextQuery, signal);
        if (request === requestRef.current && !signal?.aborted) {
          setResult(next);
          setError('');
        }
      } catch (value) {
        if (request === requestRef.current && !(value instanceof DOMException && value.name === 'AbortError')) {
          setError(value instanceof Error ? value.message : '审计查询失败。');
        }
      }
    },
    [auditGateway]
  );
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(query, controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      requestRef.current += 1;
    };
  }, [load, query]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      exportRequestRef.current += 1;
      exportingRef.current = false;
      exportControllerRef.current?.abort();
      exportControllerRef.current = undefined;
    };
  }, []);
  const actors = useMemo(
    () => Array.from(new Set(result?.events.map(({ actor }) => actor) ?? [])).sort(),
    [result?.events]
  );
  const actorOptions = query.actor && !actors.includes(query.actor) ? [query.actor, ...actors] : actors;

  const exportCsv = async () => {
    if (exportingRef.current) {
      return;
    }
    const request = ++exportRequestRef.current;
    const controller = new AbortController();
    exportControllerRef.current?.abort();
    exportControllerRef.current = controller;
    exportingRef.current = true;
    setExporting(true);
    setError('');
    try {
      const file = await auditGateway.exportAudit(query, controller.signal);
      if (request !== exportRequestRef.current || controller.signal.aborted || !mountedRef.current) {
        return;
      }
      const url = URL.createObjectURL(new Blob([file.content], { type: file.mimeType }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file.fileName;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (value) {
      if (
        request === exportRequestRef.current &&
        !controller.signal.aborted &&
        mountedRef.current &&
        !(value instanceof DOMException && value.name === 'AbortError')
      ) {
        setError(value instanceof Error ? value.message : '导出失败。');
      }
    } finally {
      if (request === exportRequestRef.current) {
        exportingRef.current = false;
        exportControllerRef.current = undefined;
        if (mountedRef.current) {
          setExporting(false);
        }
      }
    }
  };
  return (
    <main className="audit-page">
      <header className="audit-header">
        <div>
          <h1>审计日志</h1>
          <p>查看模型、工具、审批和自动化流程的操作记录。</p>
        </div>
        <div>
          <button aria-pressed={filtersOpen} onClick={() => setFiltersOpen((value) => !value)} type="button">
            <Filter size={12} />
            过滤
          </button>
          <button disabled={exporting} onClick={() => void exportCsv()} type="button">
            <Download size={12} />
            {exporting ? '导出中…' : '导出'}
          </button>
        </div>
      </header>
      {result && (
        <section aria-label="审计指标" className="audit-kpis">
          <Metric label="今日事件" note="已记录" value={result.summary.todayEvents.toLocaleString()} />
          <Metric label="模型调用" note="请求次数" value={result.summary.llmCalls} />
          <Metric label="审批决策" note="人工确认结果" tone="warning" value={result.summary.hitlDecisions} />
          <Metric label="故障切换" note="模型自动切换" tone="warning" value={result.summary.failovers} />
        </section>
      )}
      <section className="audit-toolbar">
        <label className="audit-search">
          <Search size={14} />
          <input
            aria-label="搜索审计事件"
            onChange={(event) => {
              const search = event.currentTarget.value;
              setQuery((value) => ({ ...value, search }));
            }}
            placeholder="搜索 actor / target / detail..."
            value={query.search ?? ''}
          />
        </label>
        {filtersOpen && (
          <>
            <label className="audit-filter-field">
              <span>时间</span>
              <select
                aria-label="审计时间范围"
                onChange={(event) => {
                  const timeRange = event.currentTarget.value as AuditTimeRange;
                  setQuery((value) => ({ ...value, timeRange }));
                }}
                value={query.timeRange}
              >
                <option value="today">今天</option>
                <option value="7d">7 天</option>
                <option value="30d">30 天</option>
                <option value="all">全部</option>
              </select>
            </label>
            <label className="audit-filter-field">
              <span>事件类型</span>
              <select
                aria-label="审计事件类型"
                onChange={(event) => {
                  const type = (event.currentTarget.value as AuditEventType) || undefined;
                  setQuery((value) => ({ ...value, type }));
                }}
                value={query.type ?? ''}
              >
                <option value="">全部类型</option>
                {auditEventTypes.map((type) => (
                  <option key={type}>{type}</option>
                ))}
              </select>
            </label>
            <label className="audit-filter-field">
              <span>Actor</span>
              <select
                aria-label="审计 Actor"
                onChange={(event) => {
                  const actor = event.currentTarget.value || undefined;
                  setQuery((value) => ({ ...value, actor }));
                }}
                value={query.actor ?? ''}
              >
                <option value="">全部 Actor</option>
                {actorOptions.map((actor) => (
                  <option key={actor}>{actor}</option>
                ))}
              </select>
            </label>
            <label className="audit-filter-field">
              <span>结果</span>
              <select
                aria-label="审计结果"
                onChange={(event) => {
                  const outcome = (event.currentTarget.value as AuditOutcome) || undefined;
                  setQuery((value) => ({ ...value, outcome }));
                }}
                value={query.outcome ?? ''}
              >
                <option value="">全部结果</option>
                {['ok', 'rejected', 'pending', 'err'].map((outcome) => (
                  <option key={outcome}>{outcome}</option>
                ))}
              </select>
            </label>
          </>
        )}
        <span>
          {result?.filteredCount ?? 0} 条 · {result?.retention.fileName} · 保留 {result?.retention.retentionDays} 天
        </span>
      </section>
      {error && (
        <div className="audit-error" role="alert">
          <AlertCircle size={14} />
          {error}
          <button onClick={() => void load(query)} type="button">
            重试
          </button>
        </div>
      )}
      {!result && !error && <div className="audit-state">正在查询审计事件…</div>}
      {result && (
        <section className="audit-table-wrap">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>类型</th>
                <th>Actor</th>
                <th>Target</th>
                <th>Detail</th>
                <th>结果</th>
              </tr>
            </thead>
            <tbody>
              {result.events.map((event) => (
                <AuditRow event={event} key={event.id} />
              ))}
              {!result.events.length && (
                <tr>
                  <td colSpan={6}>当前筛选下没有审计事件。</td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      )}
    </main>
  );
}
function Metric({
  label,
  note,
  tone = '',
  value,
}: {
  label: string;
  note: string;
  tone?: string;
  value: React.ReactNode;
}) {
  return (
    <article>
      <span>{label}</span>
      <strong className={tone}>{value}</strong>
      <small>{note}</small>
    </article>
  );
}
function AuditRow({ event }: { event: AuditEvent }) {
  const Icon =
    event.outcome === 'ok'
      ? CheckCircle2
      : event.outcome === 'rejected'
        ? XCircle
        : event.outcome === 'pending'
          ? ShieldCheck
          : AlertCircle;
  return (
    <tr>
      <td>
        <code>{new Date(event.occurredAt).toLocaleString()}</code>
      </td>
      <td>
        <span className="audit-type">{event.type}</span>
      </td>
      <td>{event.actor}</td>
      <td>
        <code>{event.target}</code>
      </td>
      <td>{event.detail}</td>
      <td>
        <span className={`audit-outcome ${event.outcome}`}>
          <Icon size={11} />
          {event.outcome}
        </span>
      </td>
    </tr>
  );
}
