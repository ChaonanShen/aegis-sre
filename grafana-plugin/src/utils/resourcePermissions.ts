import { FolderPermission } from '../app/model';

/**
 * The gateway has already filtered private resources to the current user.
 * Shared resources still require an Edit/Admin Folder permission to mutate.
 */
export function canEditVisibleResource(visibility: 'private' | 'shared', folderPermission?: FolderPermission): boolean {
  return visibility === 'private' || folderPermission === 'Edit' || folderPermission === 'Admin';
}
