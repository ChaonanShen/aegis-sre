export type FolderPermission = 'View' | 'Edit' | 'Admin';

export interface Folder {
  uid: string;
  title: string;
  permission: FolderPermission;
  serviceCount: number;
}
