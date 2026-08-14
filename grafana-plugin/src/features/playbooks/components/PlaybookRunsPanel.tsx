import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PlaybookRunRecord } from '../crudModel';
import { PlaybookParameter } from '../model';
import { PlaybookCrudGateway } from '../ports/PlaybookCrudGateway';

export function PlaybookRunsPanel({ gateway, playbookId, parameters = [] }: { gateway: PlaybookCrudGateway; playbookId: string; parameters?: PlaybookParameter[] }) {
  const [runs, setRuns] = useState<PlaybookRunRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [humanInput, setHumanInput] = useState('{}');
  const [actionBusy, setActionBusy] = useState(false);
  const [artifacts, setArtifacts] = useState<Awaited<ReturnType<NonNullable<PlaybookCrudGateway['listArtifacts']>>> | undefined>();
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(parameters.map((item) => [item.name, item.defaultValue])));
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void gateway.listRuns(playbookId, controller.signal).then(
      (items) => {
        if (mounted.current) {
          setRuns(items);
          setLoading(false);
        }
      },
      (reason) => {
        if (mounted.current && !isAbortError(reason)) {
          setError(toError(reason).message);
          setLoading(false);
        }
      }
    );
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [gateway, playbookId]);

  const activeRun = useMemo(() => runs.find((run) => !terminal(run.status)), [runs]);
  const latestRun = runs[0];
  const waitingInput = activeRun?.steps.find((step) => step.status === 'waiting_for_input');
  const waitingApproval = activeRun?.steps.find((step) => step.status === 'waiting_for_approval');
  const activeRunId = activeRun?.id;
  useEffect(() => {
    if (!activeRunId) {
      return;
    }
    const controller = new AbortController();
    const poll = async () => {
      try {
        if (!gateway.streamRun) {
          const next = await gateway.getRun(activeRunId, controller.signal);
          if (mounted.current) setRuns((current) => upsertRun(current, next));
          return;
        }
        for await (const next of gateway.streamRun(activeRunId, 0, controller.signal)) {
          if (!mounted.current) return;
          setRuns((current) => upsertRun(current, next));
          if (terminal(next.status)) return;
        }
      } catch (reason) {
        if (mounted.current && !isAbortError(reason)) {
          try {
            const next = await gateway.getRun(activeRunId, controller.signal);
            setRuns((current) => upsertRun(current, next));
          } catch (fallbackReason) {
            if (!isAbortError(fallbackReason)) setError(toError(reason).message);
          }
        }
      }
    };
    void poll();
    return () => {
      controller.abort();
    };
  }, [activeRunId, gateway]);

  useEffect(() => {
    if (!latestRun || !gateway.listArtifacts || !terminal(latestRun.status)) return;
    const controller = new AbortController();
    void gateway.listArtifacts(latestRun.id, controller.signal).then(setArtifacts, () => undefined);
    return () => controller.abort();
  }, [gateway, latestRun]);

  const completeHumanTask = useCallback(async () => {
    if (!activeRun || !waitingInput || !gateway.completeHumanTask || actionBusy) return;
    let input: Record<string, unknown>;
    try { input = JSON.parse(humanInput) as Record<string, unknown>; } catch { setError('Human Task 输入必须是合法 JSON。'); return; }
    setActionBusy(true); setError('');
    try {
      await gateway.completeHumanTask(activeRun.id, waitingInput.id, input, `human-${crypto.randomUUID()}`);
      const next = await gateway.getRun(activeRun.id);
      if (mounted.current) setRuns((current) => upsertRun(current, next));
    } catch (reason) { if (!isAbortError(reason)) setError(toError(reason).message); }
    finally { if (mounted.current) setActionBusy(false); }
  }, [actionBusy, activeRun, gateway, humanInput, waitingInput]);

  const resolveApproval = useCallback(async (decision: 'approve' | 'reject' | 'rewind') => {
    if (!activeRun || !waitingApproval || !gateway.resolveApproval || actionBusy) return;
    setActionBusy(true); setError('');
    try {
      await gateway.resolveApproval(activeRun.id, waitingApproval.id, decision, {}, `approval-${crypto.randomUUID()}`);
      const next = await gateway.getRun(activeRun.id);
      if (mounted.current) setRuns((current) => upsertRun(current, next));
    } catch (reason) { if (!isAbortError(reason)) setError(toError(reason).message); }
    finally { if (mounted.current) setActionBusy(false); }
  }, [actionBusy, activeRun, gateway, waitingApproval]);

  const start = useCallback(async () => {
    if (busy || activeRun) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      const run = await gateway.startRun(playbookId, { ...(Object.keys(values).length ? { parameters: values } : {}), idempotencyKey: `run-${crypto.randomUUID()}` });
      if (mounted.current) {
        setRuns((current) => upsertRun(current, run));
      }
    } catch (reason) {
      if (!isAbortError(reason)) {
        setError(toError(reason).message);
      }
    } finally {
      if (mounted.current) {
        setBusy(false);
      }
    }
  }, [activeRun, busy, gateway, playbookId, values]);

  const cancel = useCallback(async () => {
    if (!activeRun || busy) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      await gateway.cancelRun(activeRun.id);
      const next = await gateway.getRun(activeRun.id);
      if (mounted.current) {
        setRuns((current) => upsertRun(current, next));
      }
    } catch (reason) {
      if (!isAbortError(reason)) {
        setError(toError(reason).message);
      }
    } finally {
      if (mounted.current) {
        setBusy(false);
      }
    }
  }, [activeRun, busy, gateway]);

  const retry = useCallback(async () => {
    if (!latestRun || busy || (latestRun.status !== 'failed' && latestRun.status !== 'cancelled')) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (!gateway.retryRun) return;
      const next = await gateway.retryRun(latestRun.id, `retry-${crypto.randomUUID()}`);
      if (mounted.current) {
        setRuns((current) => upsertRun(current, next));
      }
    } catch (reason) {
      if (!isAbortError(reason)) {
        setError(toError(reason).message);
      }
    } finally {
      if (mounted.current) {
        setBusy(false);
      }
    }
  }, [busy, gateway, latestRun]);

  return (
    <section className="playbook-runs">
      <header>
        <div><h2>运行记录</h2><small>状态直接来自 Dagu，运行期间自动刷新。</small></div>
        {activeRun || latestRun ? (
          <div className="playbook-run-actions">
            {latestRun && (latestRun.status === 'failed' || latestRun.status === 'cancelled') && (
              <button className="playbook-button secondary" disabled={busy} onClick={() => void retry()} type="button">重试运行</button>
            )}
            {activeRun && <button className="playbook-button danger" disabled={busy} onClick={() => void cancel()} type="button">取消运行</button>}
          </div>
        ) : (
          <button className="playbook-button primary" disabled={busy} onClick={() => void start()} type="button">{busy ? '启动中…' : '运行 Playbook'}</button>
        )}
      </header>
      {parameters.length > 0 && !activeRun && (
        <div className="playbook-run-params">
          {parameters.map((parameter) => (
            <label key={parameter.name}>
              {parameter.name}{parameter.required ? ' *' : ''}
              <input aria-label={`运行参数 ${parameter.name}`} onChange={(event) => setValues((current) => ({ ...current, [parameter.name]: event.currentTarget.value }))} value={values[parameter.name] ?? ''} />
            </label>
          ))}
        </div>
      )}
      {error && <div className="playbook-editor-error" role="alert">{error}</div>}
      {waitingInput && (
        <section aria-label="Human Task" className="playbook-run-interaction">
          <h3>等待人工输入 · {waitingInput.name || waitingInput.id}</h3>
          <textarea aria-label="Human Task JSON 输入" onChange={(event) => setHumanInput(event.currentTarget.value)} value={humanInput} />
          <button className="playbook-button primary" disabled={actionBusy} onClick={() => void completeHumanTask()} type="button">提交输入</button>
        </section>
      )}
      {waitingApproval && (
        <section aria-label="Approval" className="playbook-run-interaction">
          <h3>等待审批 · {waitingApproval.name || waitingApproval.id}</h3>
          <div className="playbook-run-actions">
            <button className="playbook-button primary" disabled={actionBusy} onClick={() => void resolveApproval('approve')} type="button">批准</button>
            <button className="playbook-button secondary" disabled={actionBusy} onClick={() => void resolveApproval('reject')} type="button">拒绝</button>
            <button className="playbook-button secondary" disabled={actionBusy} onClick={() => void resolveApproval('rewind')} type="button">回退</button>
          </div>
        </section>
      )}
      {loading ? <div className="playbook-loading">正在加载运行记录…</div> : runs.length === 0 ? (
        <div className="playbook-empty compact">还没有运行记录。</div>
      ) : (
        <div className="playbook-run-list">
          {runs.map((run) => (
            <article key={run.id}>
              <div><code>{run.id}</code><span className={`playbook-run-status ${run.status}`}>{statusLabel(run.status)}</span></div>
              <small>{formatTime(run.startedAt)}</small>
              {run.steps.length > 0 && (
                <ol>{run.steps.map((step) => <li key={step.id}><span>{step.name || step.id}</span><small>{statusLabel(step.status)}</small></li>)}</ol>
              )}
              {run.id === latestRun?.id && artifacts && artifacts.length > 0 && (
                <div aria-label="Artifacts" className="playbook-artifacts">
                  <strong>Artifacts</strong>
                  {artifacts.map((artifact) => (
                    <a href={gateway.artifactDownloadUrl?.(run.id, artifact.path)} key={artifact.path} rel="noreferrer" target="_blank">{artifact.name}</a>
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function upsertRun(current: PlaybookRunRecord[], next: PlaybookRunRecord): PlaybookRunRecord[] {
  return [next, ...current.filter(({ id }) => id !== next.id)];
}

function terminal(status: PlaybookRunRecord['status']): boolean {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}

function statusLabel(status: PlaybookRunRecord['status']): string {
  return {
    queued: '排队中', running: '运行中', waiting_for_input: '等待输入', waiting_for_approval: '等待审批',
    succeeded: '成功', failed: '失败', cancelled: '已取消',
  }[status];
}

function formatTime(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? value : new Date(timestamp).toLocaleString();
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Playbook 运行操作失败。');
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
