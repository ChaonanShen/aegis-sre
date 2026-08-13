import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Database,
  Eye,
  Filter,
  GitBranch,
  RefreshCw,
  X,
  XCircle,
} from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAppServices } from '../../app/AppServices';
import { useAppShell } from '../../app/AppShellContext';
import { ROUTES } from '../../constants';
import { prefixRoute } from '../../utils/utils.routing';
import { useDialogA11y } from '../../utils/useDialogA11y';
import { AlertDetail, AlertListItem, AlertQuery, AlertSeverity, AlertStatus, AlertSummary } from './model';
import './alerts.css';

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'success'; alerts: AlertListItem[]; summary: AlertSummary };

export default function AlertsPage() {
  const { alertId } = useParams();
  const navigate = useNavigate();
  const { alertGateway, knowledgeGateway } = useAppServices();
  const { folders, setActiveFolder } = useAppShell();
  const [query, setQuery] = useState<AlertQuery>({});
  const [state, setState] = useState<State>({ status: 'loading' });
  const [detail, setDetail] = useState<AlertDetail>();
  const [refreshing, setRefreshing] = useState(false);
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [savingRunbook, setSavingRunbook] = useState(false);
  const savingRunbookRef = useRef(false);
  const saveRequestRef = useRef(0);
  const saveControllerRef = useRef<AbortController>();
  const loadRequestRef = useRef(0);
  const queryRef = useRef(query);
  const alertIdRef = useRef(alertId);
  const viewKeyRef = useRef(alertViewKey(alertId, query));
  const refreshRequestRef = useRef(0);
  const refreshControllerRef = useRef<AbortController>();
  const normalizedViewRef = useRef<string>();
  const effectiveFolderUid =
    folders.status === 'success' &&
    query.folderUid &&
    !folders.data.some(({ uid }) => uid === query.folderUid)
      ? undefined
      : query.folderUid;
  const effectiveQuery = useMemo(
    () => (effectiveFolderUid === query.folderUid ? query : { ...query, folderUid: effectiveFolderUid }),
    [effectiveFolderUid, query]
  );
  const analysisDialogRef = useDialogA11y<HTMLDivElement>(() => setAnalysisOpen(false), {
    enabled: analysisOpen,
  });

  // Keep refresh continuations tied to the view that started them. A gateway may
  // not honor AbortSignal, so the request sequence is the final stale-response guard.
  useEffect(() => {
    queryRef.current = effectiveQuery;
    alertIdRef.current = alertId;
    viewKeyRef.current = alertViewKey(alertId, effectiveQuery);
  }, [alertId, effectiveQuery]);

  // Detail, filters, and Folder scope are independent views. Clear transient
  // state as soon as the scope changes so an old modal or mutation cannot leak
  // into the newly selected alert.
  // This is an intentional navigation-scope reset; the state is not derived
  // from the query and must be cleared before the next async load completes.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setAnalysisOpen(false);
    setMessage('');
    refreshRequestRef.current += 1;
    refreshControllerRef.current?.abort();
    setRefreshing(false);
    saveRequestRef.current += 1;
    saveControllerRef.current?.abort();
    savingRunbookRef.current = false;
    setSavingRunbook(false);
  }, [alertId, effectiveQuery]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(
    () => () => {
      loadRequestRef.current += 1;
      refreshRequestRef.current += 1;
      refreshControllerRef.current?.abort();
      saveRequestRef.current += 1;
      saveControllerRef.current?.abort();
    },
    []
  );

  const load = useCallback(
    async (nextQuery: AlertQuery, nextAlertId: string | undefined, signal?: AbortSignal) => {
      const request = ++loadRequestRef.current;
      try {
        const result = await alertGateway.listAlerts(nextQuery, signal);
        if (request !== loadRequestRef.current) {
          return;
        }
        const selectedId =
          nextAlertId && result.alerts.some(({ id }) => id === nextAlertId) ? nextAlertId : result.alerts[0]?.id;
        const nextDetail = selectedId ? await alertGateway.getAlert(selectedId, signal) : undefined;
        if (request !== loadRequestRef.current) {
          return;
        }
        setState({ status: 'success', ...result });
        setDetail(nextDetail);
        if (selectedId && nextAlertId !== selectedId) {
          normalizedViewRef.current = alertViewKey(selectedId, nextQuery);
          navigate(prefixRoute(`${ROUTES.Alerts}/${selectedId}`), { replace: true });
        }
      } catch (error) {
        if (request === loadRequestRef.current && !isAbortError(error)) {
          setState({ status: 'error', message: error instanceof Error ? error.message : '告警加载失败。' });
        }
      }
    },
    [alertGateway, navigate]
  );

  useEffect(() => {
    const viewKey = alertViewKey(alertId, effectiveQuery);
    if (normalizedViewRef.current === viewKey) {
      normalizedViewRef.current = undefined;
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(effectiveQuery, alertId, controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
      // Invalidate the token immediately. A gateway may ignore AbortSignal and
      // resolve the old promise before the next scheduled load starts.
      loadRequestRef.current += 1;
    };
  }, [alertId, effectiveQuery, load]);
  const permission = useMemo(
    () =>
      folders.status === 'success' && detail
        ? folders.data.find(({ uid }) => uid === detail.folderUid)?.permission
        : undefined,
    [detail, folders]
  );
  const canSave = permission === 'Edit' || permission === 'Admin';

  const refresh = useCallback(async () => {
    const request = ++refreshRequestRef.current;
    const startedViewKey = viewKeyRef.current;
    const controller = new AbortController();
    refreshControllerRef.current?.abort();
    refreshControllerRef.current = controller;
    setRefreshing(true);
    setMessage('');
    try {
      const result = await alertGateway.refreshAlerts(controller.signal);
      if (request !== refreshRequestRef.current || viewKeyRef.current !== startedViewKey) {
        return;
      }
      setMessage(result.changedIds.length ? `已推进 ${result.changedIds.length} 条告警` : '没有需要推进的告警');
      await load(queryRef.current, alertIdRef.current);
    } catch (error) {
      if (request === refreshRequestRef.current && !isAbortError(error)) {
        setMessage(error instanceof Error ? error.message : '刷新失败。');
      }
    } finally {
      if (request === refreshRequestRef.current) {
        refreshControllerRef.current = undefined;
        setRefreshing(false);
      }
    }
  }, [alertGateway, load]);
  const select = (id: string) => navigate(prefixRoute(`${ROUTES.Alerts}/${id}`));
  const saveRunbook = async () => {
    if (!detail || !detail.aiAnalysis || !canSave || savingRunbookRef.current) {
      return;
    }
    const request = ++saveRequestRef.current;
    const startedViewKey = viewKeyRef.current;
    const controller = new AbortController();
    saveControllerRef.current?.abort();
    saveControllerRef.current = controller;
    savingRunbookRef.current = true;
    setSavingRunbook(true);
    setMessage('');
    try {
      const runbook = await knowledgeGateway.createRunbook({
        folderUid: detail.folderUid,
        title: `${detail.alertName} AI 分析`,
        tags: ['alert', detail.service],
        severity: detail.severity === 'critical' ? 'critical' : detail.severity === 'warning' ? 'warning' : 'info',
        author: 'alice',
        source: 'manual',
        excerpt: detail.summary,
        body: `# ${detail.alertName}\n\n${detail.aiAnalysis}\n\nAlert: ${detail.id}\nFingerprint: ${detail.fingerprint}`,
      }, controller.signal);
      if (request !== saveRequestRef.current || controller.signal.aborted || viewKeyRef.current !== startedViewKey) {
        return;
      }
      setActiveFolder(detail.folderUid);
      navigate(`${prefixRoute(ROUTES.Knowledge)}?tab=runbooks&runbook=${encodeURIComponent(runbook.id)}`);
    } catch (error) {
      if (request === saveRequestRef.current && !controller.signal.aborted && !isAbortError(error)) {
        setMessage(error instanceof Error ? error.message : 'Runbook 保存失败。');
      }
    } finally {
      if (request === saveRequestRef.current) {
        saveControllerRef.current = undefined;
        savingRunbookRef.current = false;
        setSavingRunbook(false);
      }
    }
  };

  if (state.status === 'loading') {
    return <div className="alerts-state">正在加载告警…</div>;
  }
  if (state.status === 'error') {
    return (
      <div className="alerts-state error" role="alert">
        {state.message}
      </div>
    );
  }
  return (
    <main className="alerts-workspace">
      <section className="alerts-master">
        <header className="alerts-header">
          <div>
            <h1>告警分析</h1>
            <p>集中查看告警，并在后台生成相关分析与处置建议。</p>
          </div>
          <button disabled={refreshing} onClick={() => void refresh()} type="button">
            <RefreshCw className={refreshing ? 'spin' : ''} size={13} />
            刷新
          </button>
        </header>
        <section aria-label="告警指标" className="alert-kpis">
          <Metric label="Firing" tone="danger" value={state.summary.firing} />
          <Metric label="Analyzing" tone="warning" value={state.summary.analyzing} />
          <Metric label="Analyzed (24h)" tone="success" value={state.summary.analyzed24h} />
          <Metric label="Failed" tone="danger" value={state.summary.failed} />
        </section>
        <div className="alert-filters">
          <Filter size={13} />
          <label className="alert-filter-field">
            <span>状态</span>
            <select
              aria-label="告警状态"
              onChange={(e) => setQuery((q) => ({ ...q, status: (e.target.value as AlertStatus) || undefined }))}
              value={query.status ?? ''}
            >
              <option value="">全部状态</option>
              {['firing', 'analyzing', 'analyzed', 'resolved', 'failed'].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <label className="alert-filter-field">
            <span>严重度</span>
            <select
              aria-label="告警严重度"
              onChange={(e) => setQuery((q) => ({ ...q, severity: (e.target.value as AlertSeverity) || undefined }))}
              value={query.severity ?? ''}
            >
              <option value="">全部严重度</option>
              {['critical', 'warning', 'info'].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
          <label className="alert-filter-field">
            <span>Folder</span>
            <select
              aria-label="告警 Folder"
              onChange={(e) => setQuery((q) => ({ ...q, folderUid: e.target.value || undefined }))}
              value={effectiveFolderUid ?? ''}
            >
              <option value="">全部 Folder</option>
              {folders.status === 'success' &&
                folders.data.map((f) => (
                  <option key={f.uid} value={f.uid}>
                    {f.title}
                  </option>
                ))}
            </select>
          </label>
        </div>
        {message && (
          <div className="alert-message" role="status">
            {message}
          </div>
        )}
        <section aria-label="告警列表" className="alert-list">
          {state.alerts.map((alert) => (
            <button
              aria-pressed={detail?.id === alert.id}
              className="alert-row"
              key={alert.id}
              onClick={() => select(alert.id)}
              type="button"
            >
              <header>
                <StatusIcon status={alert.status} />
                <code>{alert.alertName}</code>
                <span className={`alert-tag ${alert.status}`}>{alert.status}</span>
                <span className={`alert-tag ${alert.severity}`}>{alert.severity}</span>
                <time>{new Date(alert.startedAt).toLocaleTimeString()}</time>
              </header>
              <p>{alert.summary}</p>
              <footer>
                @{alert.service} · folder: {alert.folderUid} · fp: <code>{alert.fingerprint}</code>
              </footer>
            </button>
          ))}
        </section>
      </section>
      <aside className="alerts-detail">
        {detail ? (
          <>
            <section className="alert-detail-card">
              <header>
                <div>
                  <h2>{detail.alertName}</h2>
                  <p>{detail.summary}</p>
                </div>
                <span className={`alert-tag ${detail.status}`}>{detail.status}</span>
              </header>
              <dl>
                <Fact label="Service" value={`@${detail.service}`} />
                <Fact label="Folder" value={detail.folderUid} />
                <Fact label="Fingerprint" value={detail.fingerprint} />
                <Fact label="Source" value={detail.source} />
                <Fact label="Started" value={new Date(detail.startedAt).toLocaleString()} />
                <Fact label="Received" value={new Date(detail.receivedAt).toLocaleString()} />
              </dl>
              <div className="alerts-banner">
                <Database size={14} />
                <span>
                  <strong>后台分析：</strong>结合相关知识和处置流程生成建议
                </span>
              </div>
              {detail.runId && (
                <small>
                  run id: <code>{detail.runId}</code>
                </small>
              )}
            </section>
            <section className="alert-detail-card">
              <header>
                <div>
                  <h2>处理流水线</h2>
                  <p>接收告警后进入队列，并在后台生成分析结果。</p>
                </div>
              </header>
              <div className="alert-pipeline">
                {detail.pipeline.map((step, index) => (
                  <React.Fragment key={step.id}>
                    <div className={step.state}>
                      <strong>{step.label}</strong>
                      <small>{step.description}</small>
                    </div>
                    {index < detail.pipeline.length - 1 && <ArrowRight size={12} />}
                  </React.Fragment>
                ))}
              </div>
            </section>
            {detail.aiAnalysis && (
              <section className="alert-detail-card analysis">
                <header>
                  <div>
                    <h2>AI 分析结果</h2>
                    <p>结合当前空间的相关信息生成</p>
                  </div>
                  <span className="alert-tag analyzed">已完成</span>
                </header>
                <div>{detail.aiAnalysis}</div>
                <footer>
                  {detail.recommendedPlaybookId && (
                    <button
                      onClick={() => navigate(prefixRoute(`${ROUTES.Playbooks}/${detail.recommendedPlaybookId}`))}
                      type="button"
                    >
                      <GitBranch size={12} />
                      推荐 Playbook：{detail.recommendedPlaybookName ?? detail.recommendedPlaybookId}
                    </button>
                  )}
                  <button onClick={() => setAnalysisOpen(true)} type="button">
                    <Eye size={12} />
                    查看完整分析
                  </button>
                  <button
                    disabled={!canSave || savingRunbook}
                    onClick={() => void saveRunbook()}
                    title={canSave ? '' : '需要目标 Folder Edit/Admin 权限'}
                    type="button"
                  >
                    {savingRunbook ? '保存中…' : '沉淀为 Runbook'}
                  </button>
                </footer>
              </section>
            )}
            {detail.status === 'failed' && (
              <section className="alert-detail-card failure">
                <h2>分析失败</h2>
                <div>
                  <XCircle size={14} />
                  <span>
                    <strong>错误：</strong>
                    {detail.failureMessage}
                    <small>{detail.retrySummary}</small>
                  </span>
                </div>
              </section>
            )}
          </>
        ) : (
          <div className="alerts-state">当前筛选下没有告警。</div>
        )}
      </aside>
      {analysisOpen && detail?.aiAnalysis && (
        <div className="alert-modal-backdrop">
          <div
            aria-label={`${detail.alertName} 完整分析`}
            aria-modal="true"
            className="alert-modal"
            ref={analysisDialogRef}
            role="dialog"
          >
            <header>
              <h2>{detail.alertName} · 完整分析</h2>
              <button aria-label="关闭完整分析" onClick={() => setAnalysisOpen(false)} type="button">
                <X size={16} />
              </button>
            </header>
            <p>{detail.aiAnalysis}</p>
            <h3>推荐处理</h3>
            <p>
              {detail.recommendedPlaybookId
                ? `运行 ${detail.recommendedPlaybookName ?? detail.recommendedPlaybookId}，验证指标与依赖容量；执行会修改数据的步骤前仍会请求确认。`
                : '当前分析未关联推荐 Playbook；请先验证指标与依赖容量。'}
            </p>
          </div>
        </div>
      )}
    </main>
  );
}

function Metric({ label, tone, value }: { label: string; tone: string; value: number }) {
  return (
    <article>
      <span>{label}</span>
      <strong className={tone}>{value}</strong>
    </article>
  );
}
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
function StatusIcon({ status }: { status: AlertStatus }) {
  return status === 'firing' ? (
    <AlertTriangle size={14} />
  ) : status === 'failed' ? (
    <XCircle size={14} />
  ) : status === 'analyzing' ? (
    <Activity size={14} />
  ) : (
    <CheckCircle2 size={14} />
  );
}

function alertViewKey(alertId: string | undefined, query: AlertQuery): string {
  return [alertId ?? '', query.status ?? '', query.severity ?? '', query.folderUid ?? ''].join('|');
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
