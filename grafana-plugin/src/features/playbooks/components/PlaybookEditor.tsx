import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Save, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { ROUTES } from '../../../constants';
import { prefixRoute } from '../../../utils/utils.routing';
import { PlaybookDocument } from '../crudModel';
import { projectDaguSource } from '../daguSource';
import { PlaybookCrudGateway } from '../ports/PlaybookCrudGateway';
import { PlaybookDag } from './PlaybookDag';

const emptyDaguSource = `name: new-playbook
description: 新建 Aegis Playbook
steps: []
`;

export function PlaybookEditor({
  gateway,
  onSaved,
  playbook,
}: {
  gateway: PlaybookCrudGateway;
  onSaved: (playbook: PlaybookDocument) => void | Promise<void>;
  playbook?: PlaybookDocument;
}) {
  const navigate = useNavigate();
  const [source, setSource] = useState(playbook?.source ?? emptyDaguSource);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [committed, setCommitted] = useState(false);
  const operationKey = useRef(`playbook-${crypto.randomUUID()}`);
  const controllerRef = useRef<AbortController>();
  const projection = useMemo(() => {
    try {
      return { value: projectDaguSource(source), error: '' };
    } catch (reason) {
      return { value: undefined, error: toError(reason).message };
    }
  }, [source]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const save = async () => {
    if (saving || committed) {
      return;
    }
    setError('');
    if (projection.error) {
      setError(projection.error);
      return;
    }
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    setSaving(true);
    try {
      const validation = await gateway.validatePlaybook(source, controller.signal);
      if (!validation.valid) {
        setError(validation.errors.map(({ path, message }) => (path ? `${path}: ${message}` : message)).join('\n'));
        return;
      }
      const saved = playbook
        ? await gateway.updatePlaybook(playbook.id, { source }, controller.signal)
        : await gateway.createPlaybook({ source, idempotencyKey: operationKey.current }, controller.signal);
      setCommitted(true);
      await onSaved(saved);
    } catch (reason) {
      if (!isAbortError(reason)) {
        setError(toError(reason).message);
      }
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = undefined;
        setSaving(false);
      }
    }
  };

  return (
    <main className="playbooks-page playbook-editor-page">
      <header className="playbook-page-header">
        <div>
          <div className="playbook-breadcrumb">
            <button onClick={() => navigate(prefixRoute(ROUTES.Playbooks))} type="button">← 返回</button>
            <span>/</span>
            <code>{playbook ? `编辑 ${playbook.name}` : '新建 Playbook'}</code>
          </div>
          <p>原生 Dagu YAML 是唯一可写事实来源；保存前会调用 Dagu 服务端校验。</p>
        </div>
        <div className="playbook-header-actions">
          <button className="playbook-button secondary" onClick={() => navigate(-1)} type="button">
            <X size={13} /> 取消
          </button>
          <button className="playbook-button primary" disabled={saving || committed} onClick={() => void save()} type="button">
            <Save size={13} /> {saving ? '保存中…' : committed ? '已保存' : '保存'}
          </button>
        </div>
      </header>

      {error && <pre className="playbook-editor-error" role="alert">{error}</pre>}

      <div className="playbook-editor-layout">
        <section className="playbook-source-editor">
          <header><h2>Dagu YAML</h2><small>直接保存到 Dagu，不生成 Aegis DSL。</small></header>
          <textarea
            aria-label="Playbook YAML 编辑器"
            onChange={(event) => { setSource(event.currentTarget.value); setCommitted(false); }}
            spellCheck={false}
            value={source}
          />
        </section>
        <section className="playbook-panel">
          <h2>DAG 预览</h2>
          {projection.value ? <PlaybookDag steps={projection.value.steps} /> : <div className="playbook-empty">修复 YAML 后显示预览。</div>}
        </section>
      </div>
    </main>
  );
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Playbook 操作失败。');
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}
