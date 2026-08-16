import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Folder } from './model';
import { useAppServices } from './AppServices';

const STORAGE_KEY = 'aegis.shell.folder.v1';
const LEGACY_STORAGE_KEY = 'torchbearing.fixture.shell.v1';
const DEFAULT_FOLDER_UID = 'infra';

type FolderState = { status: 'loading' } | { status: 'success'; data: Folder[] } | { status: 'error'; error: Error };

interface AppShellContextValue {
  folders: FolderState;
  activeFolder?: Folder;
  setActiveFolder: (uid: string) => void;
  refreshFolders: () => void;
}

const AppShellContext = createContext<AppShellContextValue | undefined>(undefined);

export function AppShellProvider({ children }: React.PropsWithChildren) {
  const { folderGateway } = useAppServices();
  const [folders, setFolders] = useState<FolderState>({ status: 'loading' });
  const [activeFolderUid, setActiveFolderUid] = useState<string | undefined>(() => readPersistedFolderUid());
  const [refreshToken, setRefreshToken] = useState(0);
  const requestRef = useRef(0);

  useEffect(() => {
    const request = ++requestRef.current;
    const controller = new AbortController();

    void folderGateway
      .listFolders(controller.signal)
      .then((data) => {
        if (request !== requestRef.current || controller.signal.aborted) {
          return;
        }
        setFolders({ status: 'success', data });
        setActiveFolderUid((currentUid) => {
          if (data.length === 0) {
            clearPersistedFolderUid();
            return undefined;
          }
          if (data.some(({ uid }) => uid === currentUid)) {
            return currentUid;
          }

          const fallbackUid = data.find(({ uid }) => uid === DEFAULT_FOLDER_UID)?.uid ?? data[0]?.uid;
          if (!fallbackUid) {
            clearPersistedFolderUid();
            return undefined;
          }
          persistFolderUid(fallbackUid);
          return fallbackUid;
        });
      })
      .catch((error: unknown) => {
        if (request === requestRef.current && !isAbortError(error)) {
          setFolders({ status: 'error', error: toError(error) });
        }
      });

    return () => {
      requestRef.current += 1;
      controller.abort();
    };
  }, [folderGateway, refreshToken]);

  const setActiveFolder = useCallback(
    (uid: string) => {
      if (folders.status !== 'success' || !folders.data.some(({ uid: visibleUid }) => visibleUid === uid)) {
        return;
      }
      setActiveFolderUid(uid);
      persistFolderUid(uid);
    },
    [folders]
  );

  const refreshFolders = useCallback(() => {
    requestRef.current += 1;
    setFolders({ status: 'loading' });
    setRefreshToken((value) => value + 1);
  }, []);
  const activeFolder =
    folders.status === 'success' ? folders.data.find(({ uid }) => uid === activeFolderUid) : undefined;
  const value = useMemo(
    () => ({ folders, activeFolder, setActiveFolder, refreshFolders }),
    [activeFolder, folders, refreshFolders, setActiveFolder]
  );

  return <AppShellContext.Provider value={value}>{children}</AppShellContext.Provider>;
}

export function useAppShell(): AppShellContextValue {
  const value = useContext(AppShellContext);

  if (!value) {
    throw new Error('useAppShell must be used inside AppShellProvider.');
  }

  return value;
}

function readPersistedFolderUid(): string | undefined {
  try {
    const current = window.sessionStorage.getItem(STORAGE_KEY);
    if (current) {
      return current;
    }
    const legacy = window.sessionStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacy) {
      window.sessionStorage.setItem(STORAGE_KEY, legacy);
      return legacy;
    }
    return DEFAULT_FOLDER_UID;
  } catch {
    return DEFAULT_FOLDER_UID;
  }
}

function persistFolderUid(uid: string) {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, uid);
  } catch {
    // Storage can be unavailable in hardened browser contexts. In-memory state still works.
  }
}

function clearPersistedFolderUid() {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage can be unavailable in hardened browser contexts. In-memory state still works.
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Folder 加载失败。');
}
