import { Folder, FolderPermission } from '../model';

export const fixtureFolders: Folder[] = [
  { uid: 'shared', title: 'Shared', permission: 'View', serviceCount: 12 },
  { uid: 'payment', title: 'Payment', permission: 'Edit', serviceCount: 8 },
  { uid: 'search', title: 'Search', permission: 'Admin', serviceCount: 6 },
  { uid: 'infra', title: 'Infra', permission: 'View', serviceCount: 5 },
  { uid: 'biz', title: 'Biz', permission: 'View', serviceCount: 4 },
];

export const fixtureFolderPermissions: Record<string, FolderPermission> = Object.fromEntries(
  fixtureFolders.map(({ uid, permission }) => [uid, permission])
);
