import React from 'react';

export function SkillMarkdown({ body }: { body: string }) {
  return (
    <div className="skill-markdown">
      {body.split('\n').map((line, index) => {
        const key = `${index}-${line}`;
        if (line.startsWith('# ')) {
          return <h2 key={key}>{line.slice(2)}</h2>;
        }
        if (line.startsWith('## ')) {
          return <h3 key={key}>{line.slice(3)}</h3>;
        }
        if (/^\d+\.\s/.test(line)) {
          return <div className="skill-markdown-list" key={key}>{line}</div>;
        }
        if (/^[-*]\s/.test(line)) {
          return <div className="skill-markdown-list" key={key}>• {line.slice(2)}</div>;
        }
        if (!line.trim()) {
          return <div className="skill-markdown-space" key={key} />;
        }
        return <p key={key}>{line}</p>;
      })}
    </div>
  );
}
