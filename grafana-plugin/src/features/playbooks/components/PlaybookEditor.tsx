import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Save, Trash2, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Folder } from '../../../app/model';
import { prefixRoute } from '../../../utils/utils.routing';
import { ROUTES } from '../../../constants';
import { Playbook, PlaybookDefinition, PlaybookDraft, PlaybookParameter, PlaybookStep } from '../model';
import { PlaybookGateway } from '../ports/PlaybookGateway';
import { parsePlaybookSource, serializePlaybook } from '../playbookSource';
import { projectDaguSource } from '../daguSource';

type DraftLoadState =
  | { id?: string; status: 'idle' | 'loading' | 'ready' }
  | { id?: string; status: 'error'; message: string };

export function PlaybookEditor({
  draftId,
  folders,
  gateway,
  onSaved,
  playbook,
}: {
  draftId?: string;
  folders: Folder[];
  gateway: PlaybookGateway;
  onSaved: () => Promise<void>;
  playbook?: Playbook;
}) {
  const navigate = useNavigate();
  const [definition, setDefinition] = useState<PlaybookDefinition>(() =>
    playbook ? definitionOf(playbook) : emptyDefinition()
  );
  const [source, setSource] = useState(() => playbook?.source ?? serializePlaybook(definition));
  const [changeNote, setChangeNote] = useState(playbook ? '' : '初始创建');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [committed, setCommitted] = useState(false);
  const savingRef = useRef(false);
  const [draftLoad, setDraftLoad] = useState<DraftLoadState>(() => ({
    id: draftId,
    status: draftId ? 'loading' : 'idle',
  }));
  const [draftRetry, setDraftRetry] = useState(0);
  const draftRequestRef = useRef(0);
  const configDraftsRef = useRef(new Map<number, { source: string; type: PlaybookStep['type'] }>());

  // The route is the source of truth while a draft request is in flight. This
  // also avoids briefly showing the previous draft when the query parameter
  // changes between renders.
  const loadingDraft = Boolean(draftId) && (draftLoad.id !== draftId || draftLoad.status === 'loading');
  const draftError =
    draftId && draftLoad.id === draftId && draftLoad.status === 'error' ? draftLoad.message : undefined;
  // Action errors are newer and must remain visible after a draft-load error.
  const visibleError = error || draftError;

  useEffect(() => {
    const request = ++draftRequestRef.current;
    if (!draftId) {
      return;
    }
    const controller = new AbortController();
    void gateway
      .getDraft(draftId, controller.signal)
      .then((draft) => {
        if (request !== draftRequestRef.current || controller.signal.aborted) {
          return;
        }
        const next = definitionOfDraft(draft);
        setDefinition(next);
        setSource(next.source ?? serializePlaybook(next));
        setChangeNote(draft.changeNote);
        setDirty(false);
        setCommitted(false);
        setError('');
        configDraftsRef.current.clear();
        setDraftLoad({ id: draftId, status: 'ready' });
      })
      .catch((reason: unknown) => {
        if (request === draftRequestRef.current && !controller.signal.aborted && !isAbortError(reason)) {
          setDraftLoad({ id: draftId, status: 'error', message: toError(reason).message });
        }
      });
    return () => {
      draftRequestRef.current += 1;
      controller.abort();
    };
  }, [draftId, draftRetry, gateway]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const writableFolders = useMemo(
    () => folders.filter(({ permission }) => permission === 'Edit' || permission === 'Admin'),
    [folders]
  );

  const update = (next: PlaybookDefinition) => {
    setDefinition(next);
    setSource(serializePlaybook(next));
    setDirty(true);
    setError('');
  };
  const cancel = () => {
    if (!dirty || window.confirm('放弃尚未保存的修改？')) {
      navigate(playbook ? prefixRoute(`${ROUTES.Playbooks}/${playbook.id}`) : prefixRoute(ROUTES.Playbooks));
    }
  };
  const retryDraft = () => {
    if (!draftId) {
      return;
    }
    setError('');
    setDraftLoad({ id: draftId, status: 'loading' });
    setDraftRetry((value) => value + 1);
  };
  const save = async () => {
    if (Boolean(draftError) || loadingDraft || committed || savingRef.current) {
      return;
    }
    let saveDefinition: PlaybookDefinition;
    try {
      saveDefinition = definitionWithConfigDrafts(definition, configDraftsRef.current);
      if (definition.source) {
        saveDefinition = { ...saveDefinition, source };
      }
    } catch (reason) {
      setError(toError(reason).message);
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError('');
    try {
      const saved = playbook
        ? await gateway.updatePlaybook(playbook.id, { ...saveDefinition, changeNote }, playbook.recordVersion)
        : await gateway.createPlaybook({ ...saveDefinition, changeNote });
      setDirty(false);
      setCommitted(true);
      if (draftId) {
        try {
          await gateway.discardDraft(draftId);
        } catch (reason) {
          setError(`已保存，但草稿清理失败：${toError(reason).message}`);
        }
      }
      try {
        await onSaved();
      } catch (reason) {
        setError(`已保存，但列表刷新失败：${toError(reason).message}`);
        return;
      }
      navigate(prefixRoute(`${ROUTES.Playbooks}/${saved.id}`));
    } catch (reason) {
      setError(toError(reason).message);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  if (Boolean(draftId) && loadingDraft) {
    return <div className="playbook-loading">正在加载对话草稿…</div>;
  }

  if (draftError) {
    return (
      <main className="playbooks-page playbook-editor-page">
        <header className="playbook-page-header">
          <div>
            <div className="playbook-breadcrumb">
              <button onClick={cancel} type="button">
                ← 返回
              </button>
              <span>/</span>
              <code>对话草稿</code>
            </div>
            <p>草稿暂时无法读取，当前没有可保存的 Playbook 定义。</p>
          </div>
        </header>
        <section aria-label="草稿加载错误" className="playbook-editor-error draft-error" role="alert">
          <strong>草稿加载失败</strong>
          <span>{draftError}</span>
          <div className="playbook-header-actions">
            <button className="playbook-button secondary" onClick={cancel} type="button">
              返回 Playbooks
            </button>
            <button className="playbook-button primary" onClick={retryDraft} type="button">
              重试加载草稿
            </button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="playbooks-page playbook-editor-page">
      <header className="playbook-page-header">
        <div>
          <div className="playbook-breadcrumb">
            <button onClick={cancel} type="button">
              ← 返回
            </button>
            <span>/</span>
            <code>{playbook ? `编辑 ${playbook.name}` : '新建 Playbook'}</code>
          </div>
          <p>结构化表单与 YAML 使用同一份草稿；源码修改需点击“应用 YAML”。</p>
        </div>
        <div className="playbook-header-actions">
          <button className="playbook-button secondary" onClick={cancel} type="button">
            <X size={13} /> 取消
          </button>
          <button className="playbook-button primary" disabled={saving || committed} onClick={() => void save()} type="button">
            <Save size={13} /> {saving ? '保存中…' : committed ? '已保存' : '保存'}
          </button>
        </div>
      </header>

      {visibleError && (
        <div className="playbook-editor-error" role="alert">
          {visibleError}
        </div>
      )}

      <div className="playbook-editor-layout">
        <section className="playbook-editor-structured">
          <h2>结构化定义</h2>
          <div className="playbook-form-grid">
            <label>
              Name
              <input
                aria-label="Playbook name"
                onChange={(event) => update({ ...definition, name: event.currentTarget.value })}
                value={definition.name}
              />
            </label>
            <label>
              Version
              <input aria-label="Playbook version" disabled value={definition.version} />
            </label>
            <label className="wide">
              Description
              <input
                aria-label="Playbook description"
                onChange={(event) => update({ ...definition, description: event.currentTarget.value })}
                value={definition.description}
              />
            </label>
            <label>
              Visibility
              <select
                aria-label="Playbook visibility"
                onChange={(event) => {
                  const visibility = event.currentTarget.value === 'shared' ? 'shared' : 'private';
                  update({
                    ...definition,
                    visibility,
                    folderUid: visibility === 'shared' ? writableFolders[0]?.uid : undefined,
                  });
                }}
                value={definition.visibility}
              >
                <option value="private">private</option>
                <option value="shared">shared</option>
              </select>
            </label>
            <label>
              Folder
              <select
                aria-label="Playbook Folder"
                disabled={definition.visibility === 'private'}
                onChange={(event) => update({ ...definition, folderUid: event.currentTarget.value || undefined })}
                value={definition.folderUid ?? ''}
              >
                <option value="">选择可写 Folder</option>
                {writableFolders.map((folder) => (
                  <option key={folder.uid} value={folder.uid}>
                    {folder.title} · {folder.permission}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Trigger
              <select
                aria-label="Trigger type"
                onChange={(event) =>
                  update({
                    ...definition,
                    trigger: {
                      ...definition.trigger,
                      type: event.currentTarget.value === 'alert' ? 'alert' : 'manual',
                      pattern: event.currentTarget.value === 'alert' ? definition.trigger.pattern : undefined,
                    },
                  })
                }
                value={definition.trigger.type}
              >
                <option value="manual">manual</option>
                <option value="alert">alert</option>
              </select>
            </label>
            <label>
              Alert Pattern
              <input
                aria-label="Alert pattern"
                disabled={definition.trigger.type !== 'alert'}
                onChange={(event) =>
                  update({ ...definition, trigger: { ...definition.trigger, pattern: event.currentTarget.value } })
                }
                value={definition.trigger.pattern ?? ''}
              />
            </label>
          </div>

          <EditorSection
            action={
              <button
                onClick={() =>
                  update({
                    ...definition,
                    parameters: [...definition.parameters, emptyParameter(definition.parameters.length + 1)],
                  })
                }
                type="button"
              >
                <Plus size={12} /> 添加参数
              </button>
            }
            title="Parameters"
          >
            {definition.parameters.length === 0 && <div className="playbook-empty compact">没有参数。</div>}
            {definition.parameters.map((parameter, index) => (
              <div className="playbook-inline-editor" key={`${parameter.name}-${index}`}>
                <input
                  aria-label={`Parameter ${index + 1} name`}
                  onChange={(event) =>
                    updateParameter(definition, index, { ...parameter, name: event.currentTarget.value }, update)
                  }
                  placeholder="name"
                  value={parameter.name}
                />
                <select
                  aria-label={`Parameter ${index + 1} type`}
                  onChange={(event) =>
                    updateParameter(
                      definition,
                      index,
                      { ...parameter, type: event.currentTarget.value as PlaybookParameter['type'] },
                      update
                    )
                  }
                  value={parameter.type}
                >
                  <option value="string">string</option>
                  <option value="number">number</option>
                  <option value="bool">bool</option>
                </select>
                <input
                  aria-label={`Parameter ${index + 1} default`}
                  onChange={(event) =>
                    updateParameter(
                      definition,
                      index,
                      { ...parameter, defaultValue: event.currentTarget.value },
                      update
                    )
                  }
                  placeholder="default"
                  value={parameter.defaultValue}
                />
                <label className="playbook-checkbox">
                  <input
                    checked={parameter.required}
                    onChange={(event) =>
                      updateParameter(
                        definition,
                        index,
                        { ...parameter, required: event.currentTarget.checked },
                        update
                      )
                    }
                    type="checkbox"
                  />
                  required
                </label>
                <button
                  aria-label={`删除 Parameter ${index + 1}`}
                  onClick={() =>
                    update({
                      ...definition,
                      parameters: definition.parameters.filter((_, itemIndex) => itemIndex !== index),
                    })
                  }
                  type="button"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </EditorSection>

          <EditorSection
            action={
              <button
                onClick={() => {
                  configDraftsRef.current.clear();
                  update({ ...definition, steps: [...definition.steps, emptyStep(definition.steps.length + 1)] });
                }}
                type="button"
              >
                <Plus size={12} /> 添加 Step
              </button>
            }
            title="Steps"
          >
            {definition.steps.map((step, index) => (
              <StepEditor
                index={index}
                key={`step-editor-${index}`}
                onConfigDraftChange={(source, type) => configDraftsRef.current.set(index, { source, type })}
                onChange={(next) => updateStep(definition, index, next, update)}
                onDelete={() =>
                  (() => {
                    configDraftsRef.current.clear();
                    update({ ...definition, steps: definition.steps.filter((_, itemIndex) => itemIndex !== index) });
                  })()
                }
                step={step}
              />
            ))}
          </EditorSection>

          <label className="playbook-change-note">
            变更说明
            <textarea
              aria-label="变更说明"
              onChange={(event) => {
                setChangeNote(event.currentTarget.value);
                setDirty(true);
              }}
              rows={3}
              value={changeNote}
            />
          </label>
        </section>

        <section className="playbook-source-editor">
          <header>
            <div>
              <h2>YAML 源码</h2>
              <small>未知顶层字段会被拒绝，避免静默丢失。</small>
            </div>
            <button
              className="playbook-button secondary"
              onClick={() => {
                  try {
                    const parsed = definition.source ? projectDaguSource(source) : parsePlaybookSource(source);
                    configDraftsRef.current.clear();
                    setDefinition(parsed);
                  setSource(serializePlaybook(parsed));
                  setDirty(true);
                  setError('');
                } catch (reason) {
                  setError(toError(reason).message);
                }
              }}
              type="button"
            >
              应用 YAML
            </button>
          </header>
          <textarea
            aria-label="Playbook YAML 编辑器"
            onChange={(event) => {
              setSource(event.currentTarget.value);
              setDirty(true);
            }}
            spellCheck={false}
            value={source}
          />
        </section>
      </div>
    </main>
  );
}

function EditorSection({
  action,
  children,
  title,
}: React.PropsWithChildren<{ action: React.ReactNode; title: string }>) {
  return (
    <section className="playbook-editor-section">
      <header>
        <h3>{title}</h3>
        {action}
      </header>
      {children}
    </section>
  );
}

function StepEditor({
  index,
  onConfigDraftChange,
  onChange,
  onDelete,
  step,
}: {
  index: number;
  onConfigDraftChange: (source: string, type: PlaybookStep['type']) => void;
  onChange: (step: PlaybookStep) => void;
  onDelete: () => void;
  step: PlaybookStep;
}) {
  const serializedConfig = JSON.stringify(step.config, null, 2);
  const configKey = serializedConfig;
  const [configDraft, setConfigDraft] = useState(() => ({
    key: configKey,
    source: serializedConfig,
    error: '',
  }));
  const configSource = configDraft.key === configKey ? configDraft.source : serializedConfig;
  const configError = configDraft.key === configKey ? configDraft.error : '';
  return (
    <article className="playbook-step-editor">
      <header>
        <strong>Step {index + 1}</strong>
        <button aria-label={`删除 Step ${index + 1}`} onClick={onDelete} type="button">
          <Trash2 size={13} />
        </button>
      </header>
      <div className="playbook-form-grid">
        <label>
          ID
          <input
            aria-label={`Step ${index + 1} ID`}
            onChange={(event) => onChange({ ...step, id: event.currentTarget.value })}
            value={step.id}
          />
        </label>
        <label>
          Type
          <select
            aria-label={`Step ${index + 1} type`}
            onChange={(event) => {
              const type = event.currentTarget.value as PlaybookStep['type'];
              const config = defaultConfig(type);
              onChange({ ...step, type, config });
              setConfigDraft({
                key: `${step.id}\u0000${JSON.stringify(config, null, 2)}`,
                source: JSON.stringify(config, null, 2),
                error: '',
              });
            }}
            value={step.type}
          >
            {['query', 'branch', 'loop', 'template', 'mcp_call', 'parallel'].map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <label className="wide">
          Label
          <input
            aria-label={`Step ${index + 1} label`}
            onChange={(event) => onChange({ ...step, label: event.currentTarget.value })}
            value={step.label}
          />
        </label>
        <label className="wide">
          Depends on
          <input
            aria-label={`Step ${index + 1} dependencies`}
            onChange={(event) =>
              onChange({
                ...step,
                dependsOn: event.currentTarget.value
                  .split(',')
                  .map((value) => value.trim())
                  .filter(Boolean),
              })
            }
            placeholder="step_a, step_b"
            value={step.dependsOn.join(', ')}
          />
        </label>
        <label className="wide">
          Config JSON
          <textarea
            aria-label={`Step ${index + 1} config`}
            onBlur={() => {
              try {
                const config = JSON.parse(configSource) as unknown;
                if (!config || typeof config !== 'object' || Array.isArray(config)) {
                  throw new Error('Config 必须是对象。');
                }
                onChange({ ...step, config: config as Record<string, unknown> });
                setConfigDraft({ key: configKey, source: configSource, error: '' });
              } catch (reason) {
                setConfigDraft({ key: configKey, source: configSource, error: toError(reason).message });
              }
            }}
            onChange={(event) => {
              onConfigDraftChange(event.currentTarget.value, step.type);
              setConfigDraft({ key: configKey, source: event.currentTarget.value, error: configError });
            }}
            rows={5}
            value={configSource}
          />
          {configError && <small className="playbook-field-error">{configError}</small>}
        </label>
        <label className="playbook-checkbox">
          <input
            checked={step.sideEffect}
            onChange={(event) =>
              onChange({ ...step, sideEffect: event.currentTarget.checked, dryRun: event.currentTarget.checked })
            }
            type="checkbox"
          />
          会修改数据（运行前要求确认）
        </label>
      </div>
    </article>
  );
}

function updateParameter(
  definition: PlaybookDefinition,
  index: number,
  parameter: PlaybookParameter,
  update: (definition: PlaybookDefinition) => void
) {
  const parameters = [...definition.parameters];
  parameters[index] = parameter;
  update({ ...definition, parameters });
}

function updateStep(
  definition: PlaybookDefinition,
  index: number,
  step: PlaybookStep,
  update: (definition: PlaybookDefinition) => void
) {
  const steps = [...definition.steps];
  steps[index] = step;
  update({ ...definition, steps });
}

function definitionOf(playbook: Playbook): PlaybookDefinition {
  return {
    name: playbook.name,
    description: playbook.description,
    version: playbook.version,
    trigger: clone(playbook.trigger),
    parameters: clone(playbook.parameters),
    steps: clone(playbook.steps),
    experience: clone(playbook.experience),
    visibility: playbook.visibility,
    folderUid: playbook.folderUid,
  };
}

function definitionOfDraft(draft: PlaybookDraft): PlaybookDefinition {
  return {
    name: draft.name,
    description: draft.description,
    version: draft.version,
    trigger: clone(draft.trigger),
    parameters: clone(draft.parameters),
    steps: clone(draft.steps),
    experience: clone(draft.experience),
    visibility: draft.visibility,
    folderUid: draft.folderUid,
  };
}

function definitionWithConfigDrafts(
  definition: PlaybookDefinition,
  drafts: Map<number, { source: string; type: PlaybookStep['type'] }>
): PlaybookDefinition {
  if (drafts.size === 0) {
    return definition;
  }
  return {
    ...definition,
    steps: definition.steps.map((step, index) => {
      const draft = drafts.get(index);
      if (draft === undefined || draft.type !== step.type) {
        return step;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(draft.source);
      } catch (reason) {
        throw new Error(`Step ${index + 1} Config JSON 无效：${toError(reason).message}`);
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`Step ${index + 1} Config 必须是对象。`);
      }
      return { ...step, config: parsed as Record<string, unknown> };
    }),
  };
}

function emptyDefinition(): PlaybookDefinition {
  return {
    name: '',
    description: '',
    version: '0.1',
    trigger: { type: 'manual', alertLabels: {} },
    parameters: [],
    steps: [emptyStep(1)],
    experience: [],
    visibility: 'private',
  };
}

function emptyParameter(index: number): PlaybookParameter {
  return { name: `param_${index}`, type: 'string', defaultValue: '', required: false };
}

function emptyStep(index: number): PlaybookStep {
  return {
    id: `step_${index}`,
    type: 'query',
    label: `查询步骤 ${index}`,
    dependsOn: [],
    config: defaultConfig('query'),
    sideEffect: false,
    dryRun: false,
  };
}

function defaultConfig(type: PlaybookStep['type']): Record<string, unknown> {
  if (type === 'query') {
    return { dialect: 'promql', datasource: 'prometheus-prod', expr: 'up' };
  }
  if (type === 'branch') {
    return { condition: 'value > 0' };
  }
  if (type === 'mcp_call') {
    return { server: 'grafana', tool: 'query_prometheus', args: {} };
  }
  if (type === 'template') {
    return { template: '# Result' };
  }
  return {};
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Playbook 操作失败。');
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
