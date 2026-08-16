type FolderAuthorizationDeniedListener = (folderUid: string) => void;

const deniedListeners = new Set<FolderAuthorizationDeniedListener>();

/** 通知 Shell 重新读取 Grafana 权限；事件本身不改变任何授权结论。 */
export function reportFolderAuthorizationDenied(folderUid: string | undefined) {
  const normalized = folderUid?.trim();
  if (!normalized) {
    return;
  }
  for (const listener of deniedListeners) {
    listener(normalized);
  }
}

export function onFolderAuthorizationDenied(listener: FolderAuthorizationDeniedListener): () => void {
  deniedListeners.add(listener);
  return () => deniedListeners.delete(listener);
}
