import React from 'react';
import { GitBranch, Send, Sparkles, Wand2 } from 'lucide-react';
import { Folder } from '../../../app/model';

const actions = [
  { label: '@checkout-api p95 这周趋势', tag: '查询', icon: Sparkles },
  { label: '把 dashboard 加一个 p99 panel', tag: '需确认', icon: GitBranch },
  { label: '/check-cart', tag: '技能', icon: Wand2 },
  { label: '把这个排查沉淀为 playbook', tag: '保存', icon: GitBranch },
  { label: '/switch-folder search', tag: '切换', icon: Sparkles },
];

export function QuickActions({ activeFolder, onPick }: { activeFolder?: Folder; onPick: (value: string) => void }) {
  return (
    <div className="quick-actions">
      <div className="quick-actions-hint">
        <Sparkles aria-hidden size={15} />
        <span>
          当前空间：<strong>{activeFolder?.title ?? '未选择'}</strong>
          {activeFolder && `（${activeFolder.permission}）`} · 可以从这些问题开始
        </span>
      </div>
      {actions.map(({ label, tag, icon: Icon }) => (
        <button className="quick-action" key={label} onClick={() => onPick(label)} type="button">
          <Icon aria-hidden className="quick-action-icon" size={14} />
          <span className="quick-action-label">{label}</span>
          <span aria-hidden className="quick-action-meta">
            <span className="tag muted">{tag}</span>
            <Send size={12} />
          </span>
        </button>
      ))}
    </div>
  );
}
