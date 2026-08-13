import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Clock, Play, RotateCcw, Square } from 'lucide-react';
import { validateRunParameters } from '../../../utils/runParameters';
import { useDialogA11y } from '../../../utils/useDialogA11y';
import { Playbook, PlaybookRun, PlaybookRunEvent } from '../model';
import { PlaybookGateway } from '../ports/PlaybookGateway';

export function PlaybookRunPanel({
  canApprove,
  gateway,
  onSetupClose,
  playbook,
  setupOpen,
}: {
  canApprove: boolean;
  gateway: PlaybookGateway;
  onSetupClose: () => void;
  playbook: Playbook;
  setupOpen: boolean;
}) {
  const [run, setRun] = useState<PlaybookRun>();
  const [params, setParams] = useState<Record<string, string>>(() =>
    Object.fromEntries(playbook.parameters.map(({ name, defaultValue }) => [name, defaultValue]))
  );
  const [error, setError] = useState('');
  const [paramErrors, setParamErrors] = useState<Record<string, string>>({});
  const [streaming, setStreaming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const controllerRef = useRef<AbortController>();
  const cancellingRef = useRef(false);
  const generationRef = useRef(0);
  const setupDialogRef = useDialogA11y<HTMLElement>(onSetupClose, { enabled: setupOpen });

  useEffect(() => {
    const generation = ++generationRef.current;
    const controller = new AbortController();
    void gateway
      .listRuns(playbook.id, controller.signal)
      .then((runs) => {
        if (generation === generationRef.current && !controller.signal.aborted) {
          setRun(runs[0]);
        }
      })
      .catch((reason: unknown) => {
        if (generation === generationRef.current && !isAbortError(reason)) {
          setError(toError(reason).message);
        }
      });
    return () => {
      generationRef.current += 1;
      controller.abort();
      controllerRef.current?.abort();
    };
  }, [gateway, playbook.id]);

  const consume = async (source: AsyncIterable<PlaybookRunEvent>, generation: number, controller: AbortController) => {
    if (generation !== generationRef.current) {
      return;
    }
    setStreaming(true);
    setError('');
    try {
      for await (const event of source) {
        if (generation !== generationRef.current || controller.signal.aborted) {
          return;
        }
        const next = event.type === 'run_updated' ? event.payload : event.payload.run;
        setRun(next);
        if (event.type === 'run_failed') {
          setError(event.payload.message);
        }
      }
    } catch (reason) {
      if (generation === generationRef.current && !isAbortError(reason)) {
        setError(toError(reason).message);
      }
    } finally {
      if (controllerRef.current === controller) {
        setStreaming(false);
        controllerRef.current = undefined;
      }
    }
  };

  const consumeFrom = (
    createSource: () => AsyncIterable<PlaybookRunEvent>,
    generation: number,
    controller: AbortController
  ) => {
    try {
      void consume(createSource(), generation, controller);
    } catch (reason) {
      if (generation === generationRef.current && !isAbortError(reason)) {
        setError(toError(reason).message);
      }
      if (controllerRef.current === controller) {
        setStreaming(false);
        controllerRef.current = undefined;
      }
    }
  };

  const start = () => {
    if (streaming || cancellingRef.current) {
      return;
    }
    const nextErrors = validateRunParameters(playbook.parameters, params);
    if (Object.keys(nextErrors).length > 0) {
      setParamErrors(nextErrors);
      setError('请先修正运行参数。');
      return;
    }
    setParamErrors({});
    setError('');
    const generation = ++generationRef.current;
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    onSetupClose();
    consumeFrom(() => gateway.startDryRun({ playbookId: playbook.id, params }, controller.signal), generation, controller);
  };
  const resolve = (decision: 'approved' | 'skipped') => {
    if (!run || streaming || cancellingRef.current || (decision === 'approved' && !canApprove)) {
      return;
    }
    const generation = ++generationRef.current;
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    consumeFrom(() => gateway.resolveRun({ runId: run.id, decision }, controller.signal), generation, controller);
  };
  const cancel = async () => {
    if (!run || cancellingRef.current) {
      return;
    }
    const runId = run.id;
    const generation = ++generationRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    cancellingRef.current = true;
    setCancelling(true);
    setStreaming(false);
    try {
      const cancelled = await gateway.cancelRun(runId, controller.signal);
      if (generation === generationRef.current && !controller.signal.aborted) {
        setRun(cancelled);
      }
    } catch (reason) {
      if (generation === generationRef.current && !controller.signal.aborted && !isAbortError(reason)) {
        setError(toError(reason).message);
      }
    } finally {
      if (generation === generationRef.current && controllerRef.current === controller) {
        controllerRef.current = undefined;
        cancellingRef.current = false;
        setCancelling(false);
      }
    }
  };
  const retry = () => {
    if (!run || streaming || cancellingRef.current) {
      return;
    }
    const generation = ++generationRef.current;
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    consumeFrom(() => gateway.retryRun(run.id, controller.signal), generation, controller);
  };

  return (
    <>
      {setupOpen && (
        <div className="playbook-modal-backdrop" role="presentation">
          <section
            aria-label={`运行 ${playbook.name}`}
            aria-modal="true"
            className="playbook-modal"
            ref={setupDialogRef}
            role="dialog"
          >
            <header>
              <div>
                <h2>预览运行 Playbook</h2>
                <p>本次预览不会连接真实服务或执行更改。</p>
              </div>
              <button aria-label="关闭运行设置" onClick={onSetupClose} type="button">
                ×
              </button>
            </header>
            <div className="playbook-run-params">
              {playbook.parameters.length === 0 && <div className="playbook-empty compact">无需参数。</div>}
              {playbook.parameters.map((parameter, index) => (
                <label key={parameter.name}>
                  {parameter.name}
                  {parameter.required ? ' *' : ''}
                  <input
                    autoFocus={index === 0}
                    aria-describedby={
                      paramErrors[parameter.name] ? `playbook-param-error-${parameter.name}` : undefined
                    }
                    aria-invalid={paramErrors[parameter.name] ? 'true' : undefined}
                    aria-label={`Run parameter ${parameter.name}`}
                    onChange={(event) => {
                      setParams((current) => ({ ...current, [parameter.name]: event.currentTarget.value }));
                      setParamErrors((current) => {
                        if (!current[parameter.name]) {
                          return current;
                        }
                        const next = { ...current };
                        delete next[parameter.name];
                        return next;
                      });
                    }}
                    value={params[parameter.name] ?? ''}
                  />
                  {paramErrors[parameter.name] && (
                    <small className="playbook-run-param-error" id={`playbook-param-error-${parameter.name}`}>
                      {paramErrors[parameter.name]}
                    </small>
                  )}
                </label>
              ))}
            </div>
            <footer>
              <button className="playbook-button secondary" onClick={onSetupClose} type="button">
                取消
              </button>
              <button className="playbook-button primary" disabled={streaming} onClick={start} type="button">
                <Play size={13} /> 开始预览
              </button>
            </footer>
          </section>
        </div>
      )}

      {error && (
        <div className="playbook-editor-error" role="alert">
          {error}
        </div>
      )}
      {!run ? (
        <div className="playbook-empty">尚未运行。点击“预览运行”查看执行过程。</div>
      ) : (
        <section aria-label="Playbook 执行结果" className="playbook-run-layout">
          <div className="playbook-panel playbook-run-steps">
            <header>
              <div>
                <h2>{run.id} · 运行预览</h2>
                <p>
                  {run.steps.length} 个步骤 · 开始于 {new Date(run.startedAt).toLocaleTimeString('zh-CN')}
                </p>
              </div>
              <span className={`playbook-run-status ${run.status}`}>{run.status}</span>
            </header>
            {run.steps.map((step) => (
              <article className={`playbook-run-step ${step.status}`} key={step.stepId}>
                {step.status === 'success' ? (
                  <CheckCircle2 size={14} />
                ) : step.status === 'failed' ? (
                  <AlertCircle size={14} />
                ) : (
                  <Clock size={14} />
                )}
                <div>
                  <strong>
                    <code>{step.type}</code> {step.label}
                  </strong>
                  {(step.output || step.error) && <small>{step.output ?? step.error}</small>}
                </div>
                <span>{step.status}</span>
              </article>
            ))}
            {run.pendingInterrupt && (
              <div className="playbook-hitl">
                <AlertCircle size={16} />
                <div>
                  <strong>
                    步骤 <code>{run.pendingInterrupt.stepId}</code> 需要确认
                  </strong>
                  <p>
                    {run.pendingInterrupt.server}.{run.pendingInterrupt.tool} 是副作用调用；批准后仍只模拟。
                  </p>
                  <pre>{run.pendingInterrupt.preview.join('\n')}</pre>
                  <div>
                    <button
                      className="playbook-button primary"
                      disabled={!canApprove || streaming || cancelling}
                      onClick={() => resolve('approved')}
                      type="button"
                    >
                      批准模拟执行
                    </button>
                    <button
                      className="playbook-button secondary"
                      disabled={streaming || cancelling}
                      onClick={() => resolve('skipped')}
                      type="button"
                    >
                      跳过
                    </button>
                  </div>
                  {!canApprove && <small>当前只有 View 权限，不能批准，但可以跳过。</small>}
                </div>
              </div>
            )}
            <footer>
              {(run.status === 'running' || run.status === 'waiting_for_approval') && (
                <button
                  className="playbook-button secondary"
                  disabled={cancelling}
                  onClick={() => void cancel()}
                  type="button"
                >
                  <Square size={12} /> 取消运行
                </button>
              )}
              {(run.status === 'failed' || run.status === 'cancelled') && (
                <button className="playbook-button primary" disabled={streaming || cancelling} onClick={retry} type="button">
                  <RotateCcw size={12} /> 重试
                </button>
              )}
            </footer>
          </div>
          <aside className="playbook-panel playbook-run-summary">
            <h2>汇总输出</h2>
            <pre>{summaryFor(run)}</pre>
            <h2>运行记录</h2>
            <div>
              <small>
                playbook_run · {run.id} · {run.status}
              </small>
              {run.steps.map((step) => (
                <small key={step.stepId}>
                  步骤 {step.stepId} · {step.status}
                </small>
              ))}
              {run.pendingInterrupt && <small>等待用户确认</small>}
            </div>
          </aside>
        </section>
      )}
    </>
  );
}

function summaryFor(run: PlaybookRun): string {
  if (run.status !== 'success') {
    return 'Run 尚未完成，等待所有 Step 产生结果。';
  }
  return `## 排查结果

- ${run.steps.filter(({ status }) => status === 'success').length} 个步骤成功
- ${run.steps.filter(({ status }) => status === 'skipped').length} 个步骤跳过
- 未执行任何真实副作用

## 建议

结合查询结果继续检查异常依赖，并在真实执行前再次确认变更。`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Playbook Run 操作失败。');
}
