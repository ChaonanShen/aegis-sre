export class ApprovalNotFoundError extends Error {
  constructor(id: string) {
    super(`Approval "${id}" 不存在。`);
    this.name = 'ApprovalNotFoundError';
  }
}

export class ApprovalPermissionError extends Error {
  constructor(message = '只有目标 Folder Admin 可以处理该审批。') {
    super(message);
    this.name = 'ApprovalPermissionError';
  }
}

export class ApprovalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalValidationError';
  }
}

export class ApprovalVersionConflictError extends Error {
  constructor(id: string, expected: number, actual: number) {
    super(`Approval "${id}" 版本冲突：期望 ${expected}，实际 ${actual}。`);
    this.name = 'ApprovalVersionConflictError';
  }
}
