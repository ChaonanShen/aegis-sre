import { BackendSrv, FetchResponse, getBackendSrv, isFetchError } from '@grafana/runtime';
import { lastValueFrom } from 'rxjs';
import { Folder, FolderPermission } from '../model';
import { FolderGateway } from '../ports/FolderGateway';

interface GrafanaFolderSearchHit {
  uid: string;
  title: string;
  type: 'dash-folder';
}

type GrafanaPermissions = Record<string, string[]>;

const ACTION_READ = 'grafana-plugin-app.folder-resources:read';
const ACTION_WRITE = 'grafana-plugin-app.folder-resources:write';
const ACTION_ADMIN = 'grafana-plugin-app.folder-resources:admin';

export function createGrafanaFolderGateway(backendSrv: BackendSrv = getBackendSrv()): FolderGateway {
  return {
    async listFolders(signal) {
      try {
        const [folders, permissions] = await Promise.all([
          lastValueFrom(
            backendSrv.fetch<unknown[]>({
              url: '/api/search',
              method: 'GET',
              params: { type: 'dash-folder', limit: 1000 },
              abortSignal: signal,
              showErrorAlert: false,
            })
          ),
          lastValueFrom(
            backendSrv.fetch<unknown>({
              url: '/api/access-control/user/permissions',
              method: 'GET',
              abortSignal: signal,
              showErrorAlert: false,
            })
          ),
        ]);
        return parseFolders(folders, permissions);
      } catch (error) {
        if (isFetchError(error) && error.cancelled) {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
        throw error;
      }
    },
  };
}

function parseFolders(folderResponse: FetchResponse<unknown[]>, permissionResponse: FetchResponse<unknown>): Folder[] {
  if (!Array.isArray(folderResponse.data) || !folderResponse.data.every(isFolderHit)) {
    throw new Error('Grafana 返回了无效 Folder 列表。');
  }
  if (!isPermissionMap(permissionResponse.data)) {
    throw new Error('Grafana 返回了无效 Folder 权限。');
  }
  const permissions = permissionResponse.data;
  return folderResponse.data.flatMap((item) => {
    const permission = permissionOf(item.uid, permissions);
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

function isPermissionMap(value: unknown): value is GrafanaPermissions {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every((scopes) => Array.isArray(scopes) && scopes.every((scope) => typeof scope === 'string'))
  );
}

function permissionOf(folderUID: string, permissions: GrafanaPermissions): FolderPermission | undefined {
  if (hasFolderScope(permissions[ACTION_ADMIN], folderUID)) {
    return 'Admin';
  }
  if (hasFolderScope(permissions[ACTION_WRITE], folderUID)) {
    return 'Edit';
  }
  if (hasFolderScope(permissions[ACTION_READ], folderUID)) {
    return 'View';
  }
  return undefined;
}

function hasFolderScope(scopes: string[] | undefined, folderUID: string): boolean {
  return scopes?.some((scope) => scope === 'folders:*' || scope === `folders:uid:${folderUID}`) ?? false;
}
