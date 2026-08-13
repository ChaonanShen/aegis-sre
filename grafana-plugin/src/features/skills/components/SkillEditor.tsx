import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Save, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Folder } from '../../../app/model';
import { ROUTES } from '../../../constants';
import { prefixRoute } from '../../../utils/utils.routing';
import { Skill, SkillDefinition } from '../model';
import { SkillGateway } from '../ports/SkillGateway';
import { parseSkillSource, serializeSkillSource } from '../skillSource';

export function SkillEditor({
  folders,
  gateway,
  onSaved,
  skill,
}: {
  folders: Folder[];
  gateway: SkillGateway;
  onSaved: () => Promise<void>;
  skill?: Skill;
}) {
  const navigate = useNavigate();
  const [definition, setDefinition] = useState<SkillDefinition>(() => skill ? definitionOf(skill) : emptyDefinition());
  const [source, setSource] = useState(() => serializeSkillSource(definition));
  const [changeNote, setChangeNote] = useState(skill ? '' : '初始创建');
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [committed, setCommitted] = useState(false);
  const savingRef = useRef(false);
  const writableFolders = useMemo(
    () => folders.filter(({ permission }) => permission === 'Edit' || permission === 'Admin'),
    [folders]
  );

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const update = (next: SkillDefinition) => {
    setDefinition(next);
    setSource(serializeSkillSource(next));
    setDirty(true);
    setError('');
  };
  const cancel = () => {
    if (!dirty || window.confirm('放弃尚未保存的修改？')) {
      navigate(skill ? prefixRoute(`${ROUTES.Skills}/${skill.id}`) : prefixRoute(ROUTES.Skills));
    }
  };
  const applySource = () => {
    try {
      const parsed = parseSkillSource(source);
      setDefinition({ ...definition, ...parsed });
      setDirty(true);
      setError('');
    } catch (reason) {
      setError(toError(reason).message);
    }
  };
  const save = async () => {
    if (committed || savingRef.current) {
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError('');
    try {
      const saved = skill
        ? await gateway.updateSkill(skill.id, { ...definition, changeNote }, skill.recordVersion)
        : await gateway.createSkill({ ...definition, changeNote });
      setDirty(false);
      setCommitted(true);
      try {
        await onSaved();
      } catch (reason) {
        setError(`已保存，但列表刷新失败：${toError(reason).message}`);
        return;
      }
      navigate(prefixRoute(`${ROUTES.Skills}/${saved.id}`));
    } catch (reason) {
      setError(toError(reason).message);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <main className="skills-editor-page">
      <header className="skills-page-header">
        <div>
          <button className="skill-back" onClick={cancel} type="button">← 返回</button>
          <h1>{skill ? `编辑 ${skill.name}` : '新建 Skill'}</h1>
          <p>填写技能说明、使用范围和可调用工具。</p>
        </div>
        <div className="skills-actions">
          <button className="skill-button secondary" onClick={cancel} type="button"><X size={13} /> 取消</button>
          <button className="skill-button primary" disabled={saving || committed} onClick={() => void save()} type="button">
            <Save size={13} /> {saving ? '保存中…' : committed ? '已保存' : '保存'}
          </button>
        </div>
      </header>
      {error && <div className="skill-error" role="alert">{error}</div>}
      <div className="skill-editor-grid">
        <section className="skill-form">
          <h2>Skill 元数据</h2>
          <label>Name / 文件名
            <input aria-label="Skill name" disabled={!!skill} onChange={(event) => update({ ...definition, name: event.currentTarget.value })} value={definition.name} />
          </label>
          <label>Description
            <input aria-label="Skill description" onChange={(event) => update({ ...definition, description: event.currentTarget.value })} value={definition.description} />
          </label>
          <div className="skill-form-row">
            <label>Slash Command
              <input aria-label="Slash Command" onChange={(event) => update({ ...definition, slashCommand: event.currentTarget.value })} value={definition.slashCommand} />
            </label>
            <label>Timeout
              <input aria-label="Skill timeout" onChange={(event) => update({ ...definition, timeout: event.currentTarget.value })} value={definition.timeout} />
            </label>
          </div>
          <div className="skill-form-row">
            <label>Visibility
              <select aria-label="Skill visibility" onChange={(event) => {
                const visibility = event.currentTarget.value === 'shared' ? 'shared' : 'private';
                update({ ...definition, visibility, folderUid: visibility === 'shared' ? writableFolders[0]?.uid : undefined });
              }} value={definition.visibility}>
                <option value="private">private</option>
                <option value="shared">shared</option>
              </select>
            </label>
            <label>Folder
              <select aria-label="Skill Folder" disabled={definition.visibility === 'private'} onChange={(event) => update({ ...definition, folderUid: event.currentTarget.value || undefined })} value={definition.folderUid ?? ''}>
                <option value="">选择可写 Folder</option>
                {writableFolders.map((folder) => <option key={folder.uid} value={folder.uid}>{folder.title} · {folder.permission}</option>)}
              </select>
            </label>
          </div>
          <label>Allowed Tools（每行一个 server/tool）
            <textarea aria-label="Allowed Tools" onChange={(event) => update({ ...definition, allowedTools: splitLines(event.currentTarget.value) })} rows={4} value={definition.allowedTools.join('\n')} />
          </label>
          <label>Tags（逗号分隔）
            <input aria-label="Skill tags" onChange={(event) => update({ ...definition, tags: event.currentTarget.value.split(',').map((tag) => tag.trim()).filter(Boolean) })} value={definition.tags.join(', ')} />
          </label>
          <label>变更说明
            <input aria-label="Skill change note" onChange={(event) => { setChangeNote(event.currentTarget.value); setDirty(true); }} value={changeNote} />
          </label>
        </section>
        <section className="skill-source-editor">
          <header><strong>YAML frontmatter + Markdown</strong><code>data/skills/{definition.name || 'new-skill'}.md</code></header>
          <textarea aria-label="Skill source" onChange={(event) => { setSource(event.currentTarget.value); setDirty(true); }} value={source} />
          <button className="skill-button secondary" onClick={applySource} type="button">应用源码</button>
        </section>
      </div>
    </main>
  );
}

function emptyDefinition(): SkillDefinition {
  return {
    name: '',
    description: '',
    slashCommand: '/',
    allowedTools: [],
    timeout: '60s',
    parameters: [],
    tags: [],
    body: '# 新 Skill',
    visibility: 'private',
  };
}

function definitionOf(skill: Skill): SkillDefinition {
  const { name, description, slashCommand, allowedTools, timeout, parameters, tags, body, visibility, folderUid } = skill;
  return { name, description, slashCommand, allowedTools, timeout, parameters, tags, body, visibility, folderUid };
}

function splitLines(value: string): string[] {
  return value.split('\n').map((item) => item.trim()).filter(Boolean);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error('保存 Skill 失败。');
}
