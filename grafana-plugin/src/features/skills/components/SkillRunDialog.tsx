import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Clock, Play, Square, X } from 'lucide-react';
import { validateRunParameters } from '../../../utils/runParameters';
import { useDialogA11y } from '../../../utils/useDialogA11y';
import { Skill, SkillRun, SkillRunEvent } from '../model';
import { SkillGateway } from '../ports/SkillGateway';

export function SkillRunDialog({
  canApprove,
  gateway,
  onClose,
  skill,
}: {
  canApprove: boolean;
  gateway: SkillGateway;
  onClose: () => void;
  skill: Skill;
}) {
  const [run, setRun] = useState<SkillRun>();
  const [params, setParams] = useState<Record<string, string>>(() =>
    Object.fromEntries(skill.parameters.map(({ name, defaultValue }) => [name, defaultValue]))
  );
  const [loading, setLoading] = useState(true);
  const [streaming, setStreaming] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState('');
  const [paramErrors, setParamErrors] = useState<Record<string, string>>({});
  const controllerRef = useRef<AbortController>();
  const cancellingRef = useRef(false);
  const generationRef = useRef(0);
  const dialogRef = useDialogA11y<HTMLDivElement>(onClose);

  useEffect(() => {
    const generation = ++generationRef.current;
    const controller = new AbortController();
    void gateway
      .listRuns(skill.id, controller.signal)
      .then((runs) => {
        if (generation === generationRef.current && !controller.signal.aborted) {
          setRun(runs[0]);
        }
      })
      .catch((reason: unknown) => {
        if (generation === generationRef.current && !isAbortError(reason)) {
          setError(toError(reason).message);
        }
      })
      .finally(() => {
        if (generation === generationRef.current && !controller.signal.aborted) {
          setLoading(false);
        }
      });
    return () => {
      generationRef.current += 1;
      controller.abort();
      controllerRef.current?.abort();
    };
  }, [gateway, skill.id]);

  const consume = async (source: AsyncIterable<SkillRunEvent>, generation: number, controller: AbortController) => {
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
        setRun(event.payload);
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
    createSource: () => AsyncIterable<SkillRunEvent>,
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
    const nextErrors = validateRunParameters(skill.parameters, params);
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
    consumeFrom(() => gateway.startDryRun({ skillId: skill.id, params }, controller.signal), generation, controller);
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

  return (
    <div
      aria-label={`运行 ${skill.name}`}
      aria-modal="true"
      className="skill-modal-backdrop"
      ref={dialogRef}
      role="dialog"
    >
      <section className="skill-modal skill-run-modal">
        <header>
          <div>
            <h2>{skill.slashCommand} · 运行预览</h2>
            <p>预览不会连接真实服务或执行更改。</p>
          </div>
          <button aria-label="关闭运行" onClick={onClose} type="button">
            <X size={16} />
          </button>
        </header>
        <div className="skill-run-body">
          {loading ? (
            <div className="skill-empty">正在读取最近运行…</div>
          ) : !run ? (
            <section className="skill-run-setup">
              <h3>运行参数</h3>
              {skill.parameters.length === 0 && <p>此 Skill 没有参数，可直接开始。</p>}
              {skill.parameters.map((parameter, index) => (
                <label key={parameter.name}>
                  {parameter.name}
                  {parameter.required ? ' *' : ''}
                  <input
                    autoFocus={index === 0}
                    aria-describedby={paramErrors[parameter.name] ? `skill-param-error-${parameter.name}` : undefined}
                    aria-invalid={paramErrors[parameter.name] ? 'true' : undefined}
                    aria-label={`运行参数 ${parameter.name}`}
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
                    <small className="skill-run-param-error" id={`skill-param-error-${parameter.name}`}>
                      {paramErrors[parameter.name]}
                    </small>
                  )}
                </label>
              ))}
              <button className="skill-button primary" disabled={streaming || cancelling} onClick={start} type="button">
                <Play size={13} /> 开始预览
              </button>
            </section>
          ) : (
            <section aria-label="Skill 执行结果" className="skill-run-result">
              <div className="skill-run-summary">
                <span className={`skill-run-status ${run.status}`}>
                  {run.status === 'success' ? <CheckCircle2 size={14} /> : <Clock size={14} />}
                  {run.status}
                </span>
                <small>
                  {new Date(run.startedAt).toLocaleString('zh-CN')} · {run.id}
                </small>
              </div>
              {run.toolCalls.map((call) => (
                <article key={call.id}>
                  <code>{call.tool}</code>
                  <span className={`skill-tag ${call.status}`}>{call.status}</span>
                  {call.output && <p>{call.output}</p>}
                </article>
              ))}
              {run.pendingInterrupt && (
                <div className="skill-hitl">
                  <strong>需要确认 · {run.pendingInterrupt.tool}</strong>
                  <pre>{run.pendingInterrupt.preview.join('\n')}</pre>
                  <div className="skills-actions">
                    <button
                      className="skill-button secondary"
                      disabled={streaming || cancelling}
                      onClick={() => resolve('skipped')}
                      type="button"
                    >
                      跳过写操作
                    </button>
                    <button
                      className="skill-button primary"
                      disabled={!canApprove || streaming || cancelling}
                      onClick={() => resolve('approved')}
                      type="button"
                    >
                      批准模拟执行
                    </button>
                  </div>
                  {!canApprove && <small>Folder View 只能跳过；Edit/Admin 才能批准。</small>}
                </div>
              )}
              {run.resultMarkdown && <pre className="skill-run-report">{run.resultMarkdown}</pre>}
              <div className="skills-actions">
                {(run.status === 'running' || run.status === 'waiting_for_approval') && (
                  <button
                    className="skill-button danger"
                    disabled={cancelling}
                    onClick={() => void cancel()}
                    type="button"
                  >
                    <Square size={12} /> {cancelling ? '取消中…' : '取消'}
                  </button>
                )}
                {(run.status === 'success' || run.status === 'failed' || run.status === 'cancelled') && (
                  <button className="skill-button secondary" onClick={() => setRun(undefined)} type="button">
                    新运行
                  </button>
                )}
              </div>
            </section>
          )}
          {error && (
            <div className="skill-error" role="alert">
              {error}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error('Skill 运行预览失败。');
}
