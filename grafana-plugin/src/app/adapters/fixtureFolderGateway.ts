import { fixtureFolders } from '../fixtures/folderFixtures';
import { FolderGateway } from '../ports/FolderGateway';

export interface FixtureFolderGatewayOptions {
  latencyMs?: number;
}

export function createFixtureFolderGateway(options: FixtureFolderGatewayOptions = {}): FolderGateway {
  const latencyMs = options.latencyMs ?? 80;

  return {
    async listFolders(signal?: AbortSignal) {
      await delay(latencyMs, signal);
      return fixtureFolders.map((folder) => ({ ...folder }));
    },
  };
}

function delay(durationMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(abortError());
  }

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, durationMs);
    const onAbort = () => {
      window.clearTimeout(timeout);
      reject(abortError());
    };

    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}
