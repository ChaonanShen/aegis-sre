import React, { ChangeEvent, useRef, useState } from 'react';
import { AtSign, Paperclip, Send, Square, X } from 'lucide-react';
import { MessageAttachment, WorkbenchContext } from '../model';

interface ComposerProps {
  activeFolderTitle?: string;
  attachmentsEnabled: boolean;
  context?: WorkbenchContext;
  disabled: boolean;
  streaming: boolean;
  onSend: (value: string, attachments: MessageAttachment[]) => void;
  onStop: () => void;
}

export function Composer({
  activeFolderTitle,
  attachmentsEnabled,
  context,
  disabled,
  streaming,
  onSend,
  onStop,
}: ComposerProps) {
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState<MessageAttachment[]>([]);
  const [mentionsOpen, setMentionsOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isComposingRef = useRef(false);

  const send = () => {
    if (!value.trim() || disabled || streaming) {
      return;
    }
    onSend(value, attachmentsEnabled ? attachments : []);
    setValue('');
    setAttachments([]);
    setMentionsOpen(false);
  };

  const attachFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    setAttachments((current) => [
      ...current,
      ...files.map((file, index) => ({
        id: `attachment-${Date.now()}-${index}`,
        name: file.name,
        size: file.size,
        type: file.type,
      })),
    ]);
    event.currentTarget.value = '';
  };

  return (
    <div className="composer">
      {mentionsOpen && (
        <div aria-label="服务建议" className="mention-popover" role="listbox">
          {(context?.injectedServices ?? []).map((service) => (
            <button
              key={service.name}
              onClick={() => {
                setValue((current) => `${current}${current && !current.endsWith(' ') ? ' ' : ''}@${service.name} `);
                setMentionsOpen(false);
              }}
              role="option"
              type="button"
            >
              @{service.name}
              <span>{service.folderUid}</span>
            </button>
          ))}
          {context?.injectedServices.length === 0 && <span>当前 Folder 无可提及服务</span>}
        </div>
      )}
      <textarea
        aria-label="消息输入"
        className="composer-input"
        disabled={disabled && !streaming}
        onChange={(event) => setValue(event.currentTarget.value)}
        onCompositionEnd={() => {
          isComposingRef.current = false;
        }}
        onCompositionStart={() => {
          isComposingRef.current = true;
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            const legacyKeyCode = (event.nativeEvent as unknown as { keyCode?: number }).keyCode;
            if (isComposingRef.current || event.nativeEvent.isComposing || legacyKeyCode === 229) {
              return;
            }
            event.preventDefault();
            send();
          }
        }}
        placeholder={
          activeFolderTitle
            ? `描述现象、时间范围或目标；输入 @ 引用 ${activeFolderTitle} 中的服务`
            : '描述现象、时间范围或目标'
        }
        value={value}
      />
      {attachmentsEnabled && attachments.length > 0 && (
        <div className="composer-attachments">
          {attachments.map((attachment) => (
            <span className="attachment-chip" key={attachment.id}>
              <Paperclip aria-hidden size={11} />
              {attachment.name}
              <button
                aria-label={`移除附件 ${attachment.name}`}
                onClick={() => setAttachments((current) => current.filter(({ id }) => id !== attachment.id))}
                type="button"
              >
                <X aria-hidden size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="composer-actions">
        <button
          aria-label="@ 提及"
          className="icon-button"
          disabled={!activeFolderTitle}
          onClick={() => setMentionsOpen((open) => !open)}
          title={activeFolderTitle ? undefined : '请先选择 Folder'}
          type="button"
        >
          <AtSign aria-hidden size={16} />
        </button>
        {attachmentsEnabled && (
          <>
            <button
              aria-label="添加附件"
              className="icon-button"
              onClick={() => fileInputRef.current?.click()}
              type="button"
            >
              <Paperclip aria-hidden size={16} />
            </button>
            <input hidden multiple onChange={attachFiles} ref={fileInputRef} type="file" />
          </>
        )}
        <span className="composer-spacer" />
        <span className="composer-help">
          <kbd>Enter</kbd> 发送 <kbd>Shift+Enter</kbd> 换行
        </span>
        {streaming ? (
          <button className="btn btn-danger" onClick={onStop} type="button">
            <Square aria-hidden fill="currentColor" size={12} /> 停止
          </button>
        ) : (
          <button className="btn btn-primary" disabled={disabled || !value.trim()} onClick={send} type="button">
            <Send aria-hidden size={13} /> 发送
          </button>
        )}
      </div>
    </div>
  );
}
