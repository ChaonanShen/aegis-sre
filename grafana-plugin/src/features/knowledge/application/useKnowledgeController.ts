import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Folder } from '../../../app/model';
import {
  ConfirmImportInput,
  CreateRunbookInput,
  CreateServiceInput,
  ImportTask,
  KnowledgeSnapshot,
  StartImportInput,
  UpdateDocumentInput,
  UpdateRunbookInput,
  UpdateServiceInput,
} from '../model';
import { KnowledgeGateway } from '../ports/KnowledgeGateway';

export type AsyncState<T> =
  { status: 'idle' } | { status: 'loading' } | { status: 'success'; data: T } | { status: 'error'; error: Error };

export function useKnowledgeController({
  activeFolder,
  gateway,
}: {
  activeFolder?: Folder;
  gateway: KnowledgeGateway;
}) {
  const [snapshot, setSnapshot] = useState<AsyncState<KnowledgeSnapshot>>({ status: 'idle' });
  const [mutation, setMutation] = useState<AsyncState<unknown>>({ status: 'idle' });
  const [importing, setImporting] = useState(false);
  const requestRef = useRef(0);
  const mutationRef = useRef(0);
  const importRef = useRef(0);
  const activeFolderUidRef = useRef(activeFolder?.uid);
  const activeFolderRef = useRef(activeFolder);
  const previousScopeUidRef = useRef(activeFolder?.uid);
  const importControllerRef = useRef<AbortController>();
  const activeFolderUid = activeFolder?.uid;

  useEffect(() => {
    return () => {
      // Invalidate every continuation before aborting. Gateway cancellation is
      // advisory, so a request that resolves after unmount must still be ignored.
      requestRef.current += 1;
      mutationRef.current += 1;
      importRef.current += 1;
      importControllerRef.current?.abort();
      importControllerRef.current = undefined;
    };
  }, []);

  // Update scope refs in a layout effect so async callbacks see the new Folder
  // before passive effects start the replacement snapshot request.
  useLayoutEffect(() => {
    activeFolderUidRef.current = activeFolderUid;
    activeFolderRef.current = activeFolder;
  }, [activeFolder, activeFolderUid]);

  const load = useCallback(
    async (folderUid: string, signal?: AbortSignal) => {
      const request = ++requestRef.current;
      setSnapshot({ status: 'loading' });
      try {
        const next = await gateway.getSnapshot(folderUid, signal);
        if (request === requestRef.current) {
          setSnapshot({ status: 'success', data: next });
        }
      } catch (error) {
        if (request === requestRef.current && !isAbortError(error)) {
          setSnapshot({ status: 'error', error: toError(error) });
        }
      }
    },
    [gateway]
  );

  useEffect(() => {
    const previousFolderUid = previousScopeUidRef.current;
    previousScopeUidRef.current = activeFolderUid;
    if (previousFolderUid !== activeFolderUid) {
      mutationRef.current += 1;
      importRef.current += 1;
      importControllerRef.current?.abort();
      importControllerRef.current = undefined;
      setImporting(false);
      setMutation({ status: 'idle' });
    }
    if (!activeFolderUid) {
      requestRef.current += 1;
      return;
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => void load(activeFolderUid, controller.signal), 0);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
      requestRef.current += 1;
    };
  }, [activeFolderUid, load]);

  // A cleared Folder must not render data from the previous scope while the
  // effect cleanup is cancelling its request.
  const visibleSnapshot: AsyncState<KnowledgeSnapshot> = activeFolderUid ? snapshot : { status: 'idle' };

  const reload = useCallback(async () => {
    if (activeFolder) {
      await load(activeFolder.uid);
    }
  }, [activeFolder, load]);

  const mutate = useCallback(
    async <T>(operation: () => Promise<T>): Promise<T | undefined> => {
      const currentFolder = activeFolderRef.current;
      if (!currentFolder || !isWritableFolder(currentFolder)) {
        setMutation({ status: 'error', error: new Error('当前 Folder 没有写权限。') });
        return undefined;
      }
      const mutation = ++mutationRef.current;
      const folderUid = currentFolder.uid;
      setMutation({ status: 'loading' });
      try {
        const result = await operation();
        if (mutation !== mutationRef.current || activeFolderUidRef.current !== folderUid) {
          return undefined;
        }
        if (folderUid) {
          await load(folderUid);
        }
        if (mutation !== mutationRef.current || activeFolderUidRef.current !== folderUid) {
          return undefined;
        }
        // Keep write controls disabled until the post-mutation snapshot is
        // current. Otherwise a fast second click can create a duplicate while
        // the refresh request is still in flight.
        setMutation({ status: 'success', data: result });
        return result;
      } catch (error) {
        if (mutation === mutationRef.current && activeFolderUidRef.current === folderUid && !isAbortError(error)) {
          setMutation({ status: 'error', error: toError(error) });
        }
        return undefined;
      }
    },
    [load]
  );

  const resetMutation = useCallback(() => {
    // Closing an error toast must also invalidate a mutation that may still
    // be resolving after its Folder scope was replaced.
    mutationRef.current += 1;
    setMutation({ status: 'idle' });
  }, []);

  const stopImport = useCallback(() => {
    importRef.current += 1;
    mutationRef.current += 1;
    importControllerRef.current?.abort();
    importControllerRef.current = undefined;
    setImporting(false);
    setMutation({ status: 'idle' });
  }, []);

  const startImport = useCallback(
    async (input: StartImportInput) => {
      if (importing || activeFolderUidRef.current !== input.folderUid) {
        return;
      }
      const importRequest = ++importRef.current;
      const mutation = ++mutationRef.current;
      const controller = new AbortController();
      importControllerRef.current = controller;
      setImporting(true);
      setMutation({ status: 'loading' });
      let failed = false;
      try {
        for await (const event of gateway.startImport(input, controller.signal)) {
          if (
            importRequest !== importRef.current ||
            mutation !== mutationRef.current ||
            activeFolderUidRef.current !== input.folderUid
          ) {
            continue;
          }
          if (event.type === 'task_failed') {
            failed = true;
            setMutation({ status: 'error', error: new Error(event.payload.message) });
          }
          publishImportTask(event.type === 'task_updated' ? event.payload : event.payload.task, setSnapshot);
        }
        if (!failed && importRequest === importRef.current && mutation === mutationRef.current) {
          setMutation({ status: 'success', data: undefined });
        }
      } catch (error) {
        if (importRequest === importRef.current && mutation === mutationRef.current && !isAbortError(error)) {
          setMutation({ status: 'error', error: toError(error) });
        }
      } finally {
        if (importRequest === importRef.current) {
          setImporting(false);
          importControllerRef.current = undefined;
        }
      }
    },
    [gateway, importing]
  );

  return {
    snapshot: visibleSnapshot,
    mutation,
    importing,
    writable: activeFolder?.permission === 'Edit' || activeFolder?.permission === 'Admin',
    retry: reload,
    resetMutation,
    createService: (input: CreateServiceInput) => mutate(() => gateway.createService(input)),
    updateService: (id: string, input: UpdateServiceInput, version: number) =>
      mutate(() => gateway.updateService(id, input, version)),
    deleteService: (id: string, version: number) =>
      mutate(async () => {
        await gateway.deleteService(id, version);
        return true;
      }),
    createRunbook: (input: CreateRunbookInput) => mutate(() => gateway.createRunbook(input)),
    updateRunbook: (id: string, input: UpdateRunbookInput, version: number) =>
      mutate(() => gateway.updateRunbook(id, input, version)),
    deleteRunbook: (id: string, version: number) =>
      mutate(async () => {
        await gateway.deleteRunbook(id, version);
        return true;
      }),
    updateDocument: (id: string, input: UpdateDocumentInput, version: number) =>
      mutate(() => gateway.updateDocument(id, input, version)),
    deleteDocument: (id: string, version: number) =>
      mutate(async () => {
        await gateway.deleteDocument(id, version);
        return true;
      }),
    startImport,
    confirmImport: (input: ConfirmImportInput) => mutate(() => gateway.confirmImport(input)),
    retryImport: async (taskId: string) => {
      const folderUid = activeFolderUidRef.current;
      if (importing || !folderUid) {
        return;
      }
      const importRequest = ++importRef.current;
      const mutation = ++mutationRef.current;
      const controller = new AbortController();
      importControllerRef.current = controller;
      setImporting(true);
      setMutation({ status: 'loading' });
      let failed = false;
      try {
        for await (const event of gateway.retryImport(taskId, controller.signal)) {
          if (
            importRequest !== importRef.current ||
            mutation !== mutationRef.current ||
            activeFolderUidRef.current !== folderUid
          ) {
            continue;
          }
          if (event.type === 'task_failed') {
            failed = true;
            setMutation({ status: 'error', error: new Error(event.payload.message) });
          }
          publishImportTask(event.type === 'task_updated' ? event.payload : event.payload.task, setSnapshot);
        }
        if (!failed && importRequest === importRef.current && mutation === mutationRef.current) {
          setMutation({ status: 'success', data: undefined });
        }
      } catch (error) {
        if (importRequest === importRef.current && mutation === mutationRef.current && !isAbortError(error)) {
          setMutation({ status: 'error', error: toError(error) });
        }
      } finally {
        if (importRequest === importRef.current) {
          setImporting(false);
          importControllerRef.current = undefined;
        }
      }
    },
    cancelImport: (taskId: string) => mutate(() => gateway.cancelImport(taskId)),
    deleteImportTask: (taskId: string) =>
      mutate(async () => {
        await gateway.deleteImportTask(taskId);
        return true;
      }),
    stopImport,
  };
}

function publishImportTask(
  task: ImportTask,
  setSnapshot: React.Dispatch<React.SetStateAction<AsyncState<KnowledgeSnapshot>>>
) {
  setSnapshot((current) => {
    if (current.status !== 'success' || current.data.folderUid !== task.folderUid) {
      return current;
    }
    const imports = [task, ...current.data.imports.filter(({ id }) => id !== task.id)];
    return {
      status: 'success',
      data: {
        ...current.data,
        imports,
        counts: { ...current.data.counts, imports: imports.length },
      },
    };
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Knowledge 操作失败。');
}

function isWritableFolder(folder?: Folder): boolean {
  return folder?.permission === 'Edit' || folder?.permission === 'Admin';
}
