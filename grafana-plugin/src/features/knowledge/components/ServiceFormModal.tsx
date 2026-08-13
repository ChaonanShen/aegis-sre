import React, { FormEvent, useState } from 'react';
import { X } from 'lucide-react';
import { useDialogA11y } from '../../../utils/useDialogA11y';
import { CreateServiceInput, KeyMetric, ServiceEntry, ServiceTier } from '../model';

export function ServiceFormModal({
  folderUid,
  initial,
  saving,
  onClose,
  onSubmit,
}: {
  folderUid: string;
  initial?: ServiceEntry;
  saving: boolean;
  onClose: () => void;
  onSubmit: (input: CreateServiceInput) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [displayName, setDisplayName] = useState(initial?.displayName ?? '');
  const [owner, setOwner] = useState(initial?.owner ?? '');
  const [tier, setTier] = useState<ServiceTier>(initial?.tier ?? 'standard');
  const [metrics, setMetrics] = useState(() => metricsToText(initial?.keyMetrics ?? []));
  const dialogRef = useDialogA11y<HTMLElement>(() => {
    if (!saving) {
      onClose();
    }
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit({
      folderUid,
      name: name.trim(),
      displayName: displayName.trim(),
      owner: owner.trim(),
      tier,
      keyMetrics: parseMetrics(metrics),
    });
  };

  return (
    <div className="knowledge-modal-backdrop" role="presentation">
      <section
        aria-label={initial ? '编辑 Service' : '新建 Service'}
        aria-modal="true"
        className="knowledge-modal"
        ref={dialogRef}
        role="dialog"
      >
        <header>
          <strong>{initial ? `编辑 @${initial.name}` : '新建 Service'}</strong>
          <button aria-label="关闭 Service 表单" disabled={saving} onClick={onClose} type="button">
            <X aria-hidden size={16} />
          </button>
        </header>
        <form onSubmit={submit}>
          <div className="knowledge-form-grid">
            <label>
              <span>Service name</span>
              <input
                aria-label="Service name"
                autoFocus
                disabled={saving}
                onChange={(event) => setName(event.currentTarget.value)}
                placeholder="checkout-api"
                required
                value={name}
              />
            </label>
            <label>
              <span>Display name</span>
              <input
                aria-label="Display name"
                disabled={saving}
                onChange={(event) => setDisplayName(event.currentTarget.value)}
                required
                value={displayName}
              />
            </label>
            <label>
              <span>Owner</span>
              <input
                aria-label="Owner"
                disabled={saving}
                onChange={(event) => setOwner(event.currentTarget.value)}
                required
                value={owner}
              />
            </label>
            <label>
              <span>Tier</span>
              <select
                aria-label="Tier"
                disabled={saving}
                onChange={(event) => setTier(event.currentTarget.value as ServiceTier)}
                value={tier}
              >
                <option value="critical">critical</option>
                <option value="standard">standard</option>
                <option value="low">low</option>
              </select>
            </label>
          </div>
          <label>
            <span>Key Metrics</span>
            <textarea
              aria-label="Key Metrics"
              disabled={saving}
              onChange={(event) => setMetrics(event.currentTarget.value)}
              placeholder="p95_latency | histogram_quantile(0.95, ...) | &lt; 500ms"
              rows={5}
              value={metrics}
            />
            <small>每行格式：name | expr | threshold</small>
          </label>
          <footer>
            <button className="knowledge-button secondary" disabled={saving} onClick={onClose} type="button">
              取消
            </button>
            <button
              className="knowledge-button primary"
              disabled={saving || !name.trim() || !displayName.trim() || !owner.trim()}
              type="submit"
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function parseMetrics(value: string): KeyMetric[] {
  return value
    .split('\n')
    .map((line) => line.split('|').map((part) => part.trim()))
    .filter(([name]) => Boolean(name))
    .map(([name, expr = '', threshold = '-']) => ({ name, expr, threshold }));
}

function metricsToText(metrics: KeyMetric[]): string {
  return metrics.map(({ name, expr, threshold }) => `${name} | ${expr} | ${threshold}`).join('\n');
}
