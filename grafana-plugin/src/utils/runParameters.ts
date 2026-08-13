export type RunParameterType = 'string' | 'number' | 'bool';

export interface RunParameterDefinition {
  name: string;
  type: RunParameterType;
  required: boolean;
}

/** Validate the small, string-backed parameter contract used by dry-run dialogs. */
export function validateRunParameters(
  parameters: readonly RunParameterDefinition[],
  values: Readonly<Record<string, string>>
): Record<string, string> {
  const errors: Record<string, string> = {};

  parameters.forEach((parameter) => {
    const value = values[parameter.name]?.trim() ?? '';
    if (parameter.required && !value) {
      errors[parameter.name] = '此参数为必填项。';
      return;
    }
    if (!value) {
      return;
    }
    if (parameter.type === 'number' && !Number.isFinite(Number(value))) {
      errors[parameter.name] = '请输入有效数字。';
    } else if (parameter.type === 'bool' && value !== 'true' && value !== 'false') {
      errors[parameter.name] = '请输入 true 或 false。';
    }
  });

  return errors;
}
