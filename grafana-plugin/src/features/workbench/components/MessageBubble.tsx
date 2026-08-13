import React, { useMemo } from 'react';
import { renderMarkdown } from '@grafana/data';
import { Paperclip } from 'lucide-react';
import { WorkbenchMessage } from '../model';
import { ChartPreview } from './ChartPreview';
import { ChartQueryInfo } from './ChartQueryInfo';
import { ToolCallCard } from './ToolCallCard';

export function MessageBubble({ message }: { message: WorkbenchMessage }) {
  if (message.role === 'tool') {
    return (
      <div className="tool-message">
        {message.toolCalls?.map((toolCall) => (
          <ToolCallCard key={toolCall.id} toolCall={toolCall} />
        ))}
      </div>
    );
  }

  const user = message.role === 'user';
  return (
    <article className={`message${user ? ' user' : ''}`}>
      <span className={`avatar${user ? ' user-avatar' : ''}`}>{user ? 'ME' : 'AI'}</span>
      <div className="message-bubble">
        {user ? (
          <div className="message-copy">{highlightMentions(message.content)}</div>
        ) : (
          <AssistantMarkdown content={message.content} />
        )}
        {message.attachments?.map((attachment) => (
          <span className="attachment-chip" key={attachment.id}>
            <Paperclip aria-hidden size={11} />
            {attachment.name}
          </span>
        ))}
        {message.charts && message.charts.length > 0 && (
          <div className="inline-chart-grid">
            {message.charts.map((chart) => (
              <div className="inline-chart" key={chart.id}>
                <div className="inline-chart-head">
                  <strong>{chart.title}</strong>
                  <ChartQueryInfo chart={chart} />
                </div>
                <div className="inline-chart-body">
                  <ChartPreview chart={chart} />
                </div>
              </div>
            ))}
          </div>
        )}
        {message.streamStatus === 'streaming' && <span aria-label="正在输出" className="streaming-cursor" />}
        {message.streamStatus === 'stopped' && <span className="message-status">已停止</span>}
        {message.streamStatus === 'error' && <span className="message-status error">输出失败</span>}
      </div>
    </article>
  );
}

function AssistantMarkdown({ content }: { content: string }) {
  const html = useMemo(() => renderMarkdown(content, { breaks: true }), [content]);
  return <div className="message-copy message-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}

function highlightMentions(content: string): React.ReactNode {
  return content.split(/(@\w[\w-]*)/g).map((part, index) =>
    part.startsWith('@') ? (
      <span className="mention" key={`${part}-${index}`}>
        {part}
      </span>
    ) : (
      <React.Fragment key={index}>{part}</React.Fragment>
    )
  );
}
