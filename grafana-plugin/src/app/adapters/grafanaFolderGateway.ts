import { BackendSrv, FetchResponse, getBackendSrv, isFetchError } from '@grafana/runtime';
import { lastValueFrom } from 'rxjs';
import { Folder, FolderPermission } from '../model';
import { FolderGateway } from '../ports/FolderGateway';

interface GrafanaFolderSearchHit {
  uid: string;
  title: string;
  type: 'dash-folder';
  accessControl?: Record<string, boolean>;
}

export function createGrafanaFolderGateway(backendSrv: BackendSrv = getBackendSrv()): FolderGateway {
  return {
    async listFolders(signal) {
      try {
        const response = await lastValueFrom(
          backendSrv.fetch<unknown[]>({
            url: '/api/search',
            method: 'GET',
            params: { type: 'dash-folder', limit: 1000 },
            abortSignal: signal,
            showErrorAlert: false,
          })
        );
        return parseFolders(response);
      } catch (error) {
        if (isFetchError(error) && error.cancelled) {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
        throw error;
      }
    },
  };
}

function parseFolders(response: FetchResponse<unknown[]>): Folder[] {
  if (!Array.isArray(response.data) || !response.data.every(isFolderHit)) {
    throw new Error('Grafana 返回了无效 Folder 列表。');
  }
  return response.data.flatMap((item) => {
    const permission = permissionOf(item.accessControl);
    return permission ? [{ uid: item.uid, title: item.title, permission, serviceCount: 0 }] : [];
  });
}

function isFolderHit(value: unknown): value is GrafanaFolderSearchHit {
  return (
    typeof value === 'object' &&
    value !== null &&
    'uid' in value &&
    typeof value.uid === 'string' &&
    'title' in value &&
    typeof value.title === 'string' &&
    'type' in value &&
    value.type === 'dash-folder'
  );
}

function permissionOf(actions: Record<string, boolean> | undefined): FolderPermission | undefined {
  if (actions?.['grafana-plugin-app.folder-resources:admin']) {
    return 'Admin';
  }
  if (actions?.['grafana-plugin-app.folder-resources:write']) {
    return 'Edit';
  }
  if (actions?.['grafana-plugin-app.folder-resources:read']) {
    return 'View';
  }
  return undefined;
}
