export class PlaybookNotFoundError extends Error {
  constructor(kind: 'Playbook' | 'Draft' | 'Run', id: string) {
    super(`${kind} "${id}" 不存在。`);
    this.name = 'PlaybookNotFoundError';
  }
}

export class PlaybookPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaybookPermissionError';
  }
}

export class PlaybookVersionConflictError extends Error {
  constructor(id: string, expected: number, actual: number) {
    super(`Playbook "${id}" 版本冲突：期望 ${expected}，实际 ${actual}。`);
    this.name = 'PlaybookVersionConflictError';
  }
}

export class PlaybookValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaybookValidationError';
  }
}
