export class KnowledgeNotFoundError extends Error {
  constructor(resource: string, id: string) {
    super(`${resource} "${id}" 不存在。`);
    this.name = 'KnowledgeNotFoundError';
  }
}

export class KnowledgePermissionError extends Error {
  constructor(folderUid: string) {
    super(`当前用户对 Folder "${folderUid}" 没有写权限。`);
    this.name = 'KnowledgePermissionError';
  }
}

export class KnowledgeVersionConflictError extends Error {
  constructor(resource: string, id: string) {
    super(`${resource} "${id}" 已被其他修改更新，请重新加载。`);
    this.name = 'KnowledgeVersionConflictError';
  }
}

export class KnowledgeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeValidationError';
  }
}
