import React, { useMemo, useState } from 'react';
import { AlertCircle, Edit2, History, Play, Plus, Search, Tag, Wand2 } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAppServices } from '../../app/AppServices';
import { useAppShell } from '../../app/AppShellContext';
import { Folder } from '../../app/model';
import { ROUTES } from '../../constants';
import { prefixRoute } from '../../utils/utils.routing';
import { canEditVisibleResource } from '../../utils/resourcePermissions';
import { useSkillsController } from './application/useSkillsController';
import { SkillHistoryDialog } from './components/SkillDialogs';
import { SkillEditor } from './components/SkillEditor';
import { SkillMarkdown } from './components/SkillMarkdown';
import { SkillRunDialog } from './components/SkillRunDialog';
import { Skill } from './model';
import { SkillGateway } from './ports/SkillGateway';
import { serializeSkillSource } from './skillSource';
import './skills.css';

export default function SkillsPage() {
  const location = useLocation();
  const routeTail = location.pathname.split(`/${ROUTES.Skills}/`)[1] ?? '';
  const [resourceId, action] = routeTail.split('/');
  const { skillGateway } = useAppServices();
  const { folders } = useAppShell();
  const folderList = useMemo(() => (folders.status === 'success' ? folders.data : []), [folders]);
  const controller = useSkillsController({ folders: folderList, gateway: skillGateway });

  if (controller.state.status === 'loading') {
    return <div className="skills-loading">正在加载 Skills…</div>;
  }
  if (controller.state.status === 'error') {
    return (
      <div className="skill-error" role="alert">
        <AlertCircle size={16} />
        <span>{controller.state.error.message}</span>
        <button onClick={() => void controller.reload()} type="button">
          重试
        </button>
      </div>
    );
  }
  if (resourceId === 'new') {
    return <SkillEditor folders={folderList} gateway={skillGateway} key="new" onSaved={controller.reload} />;
  }
  if (resourceId && action === 'edit') {
    const skill = controller.state.data.find(({ id }) => id === resourceId);
    if (!skill) {
      return <SkillMissing />;
    }
    const permission = skill.folderUid ? folderList.find(({ uid }) => uid === skill.folderUid)?.permission : undefined;
    if (!canEditVisibleResource(skill.visibility, permission)) {
      return <SkillDetail folders={folderList} gateway={skillGateway} onChanged={controller.reload} skill={skill} />;
    }
    return (
      <SkillEditor
        folders={folderList}
        gateway={skillGateway}
        key={`edit:${skill.id}`}
        onSaved={controller.reload}
        skill={skill}
      />
    );
  }
  const selected = resourceId ? controller.state.data.find(({ id }) => id === resourceId) : controller.state.data[0];
  if (resourceId && !selected) {
    return <SkillMissing />;
  }
  return (
    <SkillsWorkspace
      folders={folderList}
      gateway={skillGateway}
      onChanged={controller.reload}
      selected={selected}
      skills={controller.state.data}
    />
  );
}

function SkillsWorkspace({
  folders,
  gateway,
  onChanged,
  selected,
  skills,
}: {
  folders: Folder[];
  gateway: SkillGateway;
  onChanged: () => Promise<void>;
  selected?: Skill;
  skills: Skill[];
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return skills.filter(
      (skill) =>
        !normalized ||
        `${skill.name} ${skill.slashCommand} ${skill.description} ${skill.tags.join(' ')}`
          .toLocaleLowerCase()
          .includes(normalized)
    );
  }, [query, skills]);
  return (
    <main className="skills-workspace">
      <section className="skills-list-pane">
        <header className="skills-page-header">
          <div>
            <h1>Skills</h1>
            <p>创建和管理调查过程中可复用的技能。</p>
          </div>
          <button
            className="skill-button primary"
            onClick={() => navigate(prefixRoute(`${ROUTES.Skills}/new`))}
            type="button"
          >
            <Plus size={13} /> 新建
          </button>
        </header>
        <label className="skills-search">
          <Search size={15} />
          <span className="sr-only">搜索 Skill</span>
          <input
            aria-label="搜索 Skill"
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="搜索 skill..."
            value={query}
          />
        </label>
        <div aria-label="Skill 列表" className="skill-card-list" role="region">
          {filtered.map((skill) => (
            <button
              aria-pressed={selected?.id === skill.id}
              className={`skill-card ${selected?.id === skill.id ? 'selected' : ''}`}
              key={skill.id}
              onClick={() => navigate(prefixRoute(`${ROUTES.Skills}/${skill.id}`))}
              type="button"
            >
              <div className="skill-card-top">
                <Wand2 size={14} />
                <code>{skill.slashCommand}</code>
                <span className={`skill-tag ${skill.visibility}`}>{skill.visibility}</span>
              </div>
              <strong>{skill.name}</strong>
              <p>{skill.description}</p>
              <div className="skill-card-footer">
                {skill.tags.map((tag) => (
                  <span className="skill-tag" key={tag}>
                    <Tag size={9} /> {tag}
                  </span>
                ))}
                <span className="skill-tag uses">{skill.usageCount} uses</span>
              </div>
            </button>
          ))}
          {filtered.length === 0 && <div className="skill-empty">没有符合搜索条件的 Skill。</div>}
        </div>
      </section>
      <section className="skills-detail-pane">
        {selected ? (
          <SkillDetail folders={folders} gateway={gateway} key={selected.id} onChanged={onChanged} skill={selected} />
        ) : (
          <div className="skill-empty">还没有 Skill，请先新建。</div>
        )}
      </section>
    </main>
  );
}

function SkillDetail({
  folders,
  gateway,
  onChanged,
  skill,
}: {
  folders: Folder[];
  gateway: SkillGateway;
  onChanged: () => Promise<void>;
  skill: Skill;
}) {
  const navigate = useNavigate();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState('');
  const permission = skill.folderUid ? folders.find(({ uid }) => uid === skill.folderUid)?.permission : undefined;
  const writable = canEditVisibleResource(skill.visibility, permission);
  const remove = async () => {
    if (!writable || deleting || !window.confirm(`删除 Skill "${skill.name}"？`)) {
      return;
    }
    setDeleting(true);
    setActionError('');
    try {
      await gateway.deleteSkill(skill.id, skill.recordVersion);
      await onChanged();
      navigate(prefixRoute(ROUTES.Skills));
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : '删除 Skill 失败。');
    } finally {
      setDeleting(false);
    }
  };
  return (
    <div className="skill-detail">
      <header className="skills-page-header">
        <div>
          <div className="skill-detail-title">
            <code>{skill.slashCommand}</code>
            <span className="skill-tag shared">{skill.name}</span>
            <span className={`skill-tag ${skill.visibility}`}>
              {skill.visibility}
              {skill.folderUid ? ` · ${skill.folderUid}` : ''}
            </span>
          </div>
          <p>{skill.description}</p>
        </div>
        <div className="skills-actions">
          <button className="skill-button secondary" onClick={() => setHistoryOpen(true)} type="button">
            <History size={13} /> History
          </button>
          <button
            className="skill-button secondary"
            disabled={!writable}
            onClick={() => navigate(prefixRoute(`${ROUTES.Skills}/${skill.id}/edit`))}
            type="button"
          >
            <Edit2 size={13} /> 编辑
          </button>
          <button className="skill-button primary" onClick={() => setRunOpen(true)} type="button">
            <Play size={13} /> 预览运行
          </button>
          <button
            className="skill-button danger"
            disabled={!writable || deleting}
            onClick={() => void remove()}
            type="button"
          >
            {deleting ? '删除中…' : '删除'}
          </button>
        </div>
      </header>
      {actionError && (
        <div className="skill-error" role="alert">
          {actionError}
        </div>
      )}
      <div className="skill-facts">
        <section>
          <h2>基础信息</h2>
          <dl>
            <div>
              <dt>负责人</dt>
              <dd>{skill.ownerId}</dd>
            </div>
            <div>
              <dt>命令</dt>
              <dd>
                <code>{skill.slashCommand}</code>
              </dd>
            </div>
            <div>
              <dt>使用次数</dt>
              <dd>{skill.usageCount} 次</dd>
            </div>
            <div>
              <dt>可见范围</dt>
              <dd>
                <span className={`skill-tag ${skill.visibility}`}>
                  {skill.visibility === 'shared' ? `团队共享 · ${skill.folderUid}` : '仅自己可见'}
                </span>
              </dd>
            </div>
          </dl>
        </section>
        <section>
          <h2>可调用工具</h2>
          <div className="skill-tools">
            {skill.allowedTools.length ? (
              skill.allowedTools.map((tool) => <code key={tool}>{tool}</code>)
            ) : (
              <span>未限制</span>
            )}
          </div>
        </section>
      </div>
      <div className="skill-source-preview">
        <section>
          <header>
            <span>YAML frontmatter + Markdown</span>
            <code>data/skills/{skill.name}.md</code>
          </header>
          <pre aria-label="Skill source">{serializeSkillSource(skill)}</pre>
        </section>
        <section>
          <header>
            <span>渲染预览</span>
            <small>实时同步</small>
          </header>
          <div className="skill-preview">
            <h1>{skill.name}</h1>
            <p>{skill.description}</p>
            <SkillMarkdown body={skill.body} />
          </div>
        </section>
      </div>
      {historyOpen && <SkillHistoryDialog onClose={() => setHistoryOpen(false)} skill={skill} />}
      {runOpen && (
        <SkillRunDialog
          canApprove={writable}
          gateway={gateway}
          key={skill.id}
          onClose={() => setRunOpen(false)}
          skill={skill}
        />
      )}
    </div>
  );
}

function SkillMissing() {
  const navigate = useNavigate();
  return (
    <div className="skill-empty">
      找不到这个 Skill。
      <button onClick={() => navigate(prefixRoute(ROUTES.Skills))} type="button">
        返回列表
      </button>
    </div>
  );
}
