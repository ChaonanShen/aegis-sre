import { useCallback, useEffect, useRef, useState } from 'react';
import { Folder } from '../../../app/model';
import { Playbook } from '../model';
import { PlaybookGateway } from '../ports/PlaybookGateway';

export type PlaybookState =
  | { status: 'loading' }
  | { status: 'success'; data: Playbook[] }
  | { status: 'error'; error: Error };

export function usePlaybooksController({
  folders,
  gateway,
}: {
  folders: Folder[];
  gateway: PlaybookGateway;
}) {
  const [state, setState] = useState<PlaybookState>({ status: 'loading' });
  const requestRef = useRef(0);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const request = ++requestRef.current;
      setState({ status: 'loading' });
      try {
        const data = await gateway.listPlaybooks({ folderUids: folders.map(({ uid }) => uid) }, signal);
        if (request === requestRef.current) {
          setState({ status: 'success', data });
        }
      } catch (error) {
        if (request === requestRef.current && !isAbortError(error)) {
          setState({ status: 'error', error: toError(error) });
        }
      }
    },
    [folders, gateway]
  );

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => void load(controller.signal), 0);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
      // AbortSignal is advisory: a gateway may resolve the old request anyway.
      // Invalidate it before the next scheduled load can publish stale data.
      requestRef.current += 1;
    };
  }, [load]);

  return { state, reload: load };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Playbook 加载失败。');
}
