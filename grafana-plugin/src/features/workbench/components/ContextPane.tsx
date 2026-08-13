import React from 'react';
import { GitBranch, Wand2, X } from 'lucide-react';
import { AsyncState } from '../application/useWorkbenchController';
import { WorkbenchContext } from '../model';

export function ContextPane({
  context,
  onClose,
  onRetry,
}: {
  context: AsyncState<WorkbenchContext>;
  onClose: () => void;
  onRetry: () => void;
}) {
  const data = context.status === 'success' ? context.data : undefined;

  return (
    <aside aria-label="上下文" className="chat-pane context-pane" id="workbench-context-pane">
      <div className="pane-header">
        <span className="pane-heading">
          <strong>调查上下文</strong>
          <small>本会话可访问的证据范围</small>
        </span>
        {data && <code>{data.activeFolder.uid}</code>}
        <button aria-label="关闭上下文" className="icon-button" onClick={onClose} type="button">
          <X aria-hidden size={16} />
        </button>
      </div>
      <div className="pane-body">
        {context.status === 'idle' && <div className="pane-state">选择 Folder 后可查看调查上下文。</div>}
        {context.status === 'loading' && <div className="pane-state">正在加载上下文…</div>}
        {context.status === 'error' && (
          <div className="pane-state" role="alert">
            <strong>上下文加载失败</strong>
            <span>{context.error.message}</span>
            <button className="btn btn-secondary btn-sm" onClick={onRetry} type="button">
              重试
            </button>
          </div>
        )}
        {data && (
          <>
            <section className="context-section">
              <h3>当前 Folder</h3>
              <div className="context-item">
                <span className="context-dot ok" />
                <strong>{data.activeFolder.title}</strong>
                <span>{data.activeFolder.permission}</span>
              </div>
              <div className="context-item muted">
                <span className="context-dot shared" />
                <strong>{data.sharedFolder.title}</strong>
                <span>{data.sharedFolder.permission}</span>
              </div>
            </section>
            <section className="context-section">
              <h3>可用服务</h3>
              {data.injectedServices.length === 0 && <div className="context-empty">当前空间暂无可引用服务</div>}
              {data.injectedServices.map((service) => (
                <div className="context-item" key={service.name}>
                  <span className={`context-dot ${service.tier}`} />
                  <strong>@{service.name}</strong>
                  <span className="tag muted">{service.folderUid}</span>
                </div>
              ))}
            </section>
            {data.skills.length > 0 && (
              <section className="context-section skills">
                <h3>相关 Skills</h3>
                {data.skills.map((skill) => (
                  <div className="context-item" key={skill.name}>
                    <Wand2 aria-hidden size={13} />
                    <strong>{skill.name}</strong>
                    <span>{skill.description}</span>
                  </div>
                ))}
              </section>
            )}
            {data.recent.length > 0 && (
              <section className="context-section playbooks">
                <h3>相关 Playbooks</h3>
                {data.recent.map((item) => (
                  <div className="context-item" key={item.name}>
                    <GitBranch aria-hidden size={13} />
                    <strong>{item.name}</strong>
                    <span className="tag muted">{item.type}</span>
                  </div>
                ))}
              </section>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
