import React, { useState } from 'react';
import { AlertCircle, CheckCircle2, ChevronRight, Clock, Wrench } from 'lucide-react';
import { ToolCall } from '../model';

export function ToolCallCard({ toolCall }: { toolCall: ToolCall }) {
  const Icon = toolCall.status === 'ok' ? CheckCircle2 : toolCall.status === 'err' ? AlertCircle : Clock;
  const [open, setOpen] = useState(() => toolCall.status !== 'ok');

  return (
    <details
      className={`tool-call ${toolCall.status}`}
      data-testid={`tool-call-${toolCall.id}`}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      open={open}
    >
      <summary className="tool-call-head">
        <ChevronRight aria-hidden className="tool-call-chevron" size={13} />
        <Wrench aria-hidden size={13} />
        <code>
          {toolCall.server}.{toolCall.tool}
        </code>
        <span className="tag muted">{toolCall.tier}</span>
        <span className="tool-call-duration">
          <Icon aria-hidden size={13} />
          {toolCall.durationMs === undefined ? 'pending...' : `${toolCall.durationMs}ms`}
        </span>
      </summary>
      <div className="tool-call-detail">
        {toolCall.args && <pre>{toolCall.args}</pre>}
        {toolCall.result && <div className="tool-call-result">{toolCall.result}</div>}
      </div>
    </details>
  );
}
