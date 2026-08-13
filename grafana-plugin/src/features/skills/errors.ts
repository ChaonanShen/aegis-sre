export class SkillNotFoundError extends Error {
  constructor(id: string) {
    super(`Skill "${id}" 不存在。`);
    this.name = 'SkillNotFoundError';
  }
}

export class SkillPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillPermissionError';
  }
}

export class SkillVersionConflictError extends Error {
  constructor(id: string, expected: number, actual: number) {
    super(`Skill "${id}" 版本冲突：期望 ${expected}，实际 ${actual}。`);
    this.name = 'SkillVersionConflictError';
  }
}

export class SkillValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillValidationError';
  }
}
