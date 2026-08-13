import React from 'react';
import { X } from 'lucide-react';
import { useDialogA11y } from '../../../utils/useDialogA11y';
import { Skill } from '../model';

export function SkillHistoryDialog({ onClose, skill }: { onClose: () => void; skill: Skill }) {
  const dialogRef = useDialogA11y<HTMLElement>(onClose);
  return (
    <div className="skill-modal-backdrop" role="presentation">
      <section aria-label="Skill 历史" aria-modal="true" className="skill-modal" ref={dialogRef} role="dialog">
        <header>
          <div>
            <h2>History · {skill.name}</h2>
            <p>每次保存都会留下完整定义快照。</p>
          </div>
          <button aria-label="关闭历史" onClick={onClose} type="button"><X size={16} /></button>
        </header>
        <div className="skill-history-list">
          {skill.revisions.map((revision) => (
            <article key={revision.revision}>
              <strong>Revision {revision.revision}</strong>
              <span>{revision.changeNote}</span>
              <small>{revision.author} · {new Date(revision.savedAt).toLocaleString('zh-CN')}</small>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
