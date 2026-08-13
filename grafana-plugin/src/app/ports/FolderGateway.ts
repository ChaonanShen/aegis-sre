import { Folder } from '../model';

export interface FolderGateway {
  listFolders(signal?: AbortSignal): Promise<Folder[]>;
}
