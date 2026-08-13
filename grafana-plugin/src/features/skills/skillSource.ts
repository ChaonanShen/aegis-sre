const { parse, stringify } = require('yaml') as typeof import('yaml');
import { SkillDefinition, SkillParameter } from './model';
import { SkillValidationError } from './errors';

const ALLOWED_KEYS = new Set([
  'name',
  'description',
  'slash-command',
  'allowed-tools',
  'timeout',
  'parameters',
]);

export type SkillSourceDefinition = Pick<
  SkillDefinition,
  'name' | 'description' | 'slashCommand' | 'allowedTools' | 'timeout' | 'parameters' | 'body'
>;

export function serializeSkillSource(definition: SkillSourceDefinition): string {
  const frontmatter = stringify(
    {
      name: definition.name,
      description: definition.description,
      'slash-command': definition.slashCommand,
      'allowed-tools': definition.allowedTools,
      timeout: definition.timeout,
      ...(definition.parameters.length
        ? {
            parameters: definition.parameters.map((parameter) => ({
              name: parameter.name,
              type: parameter.type,
              description: parameter.description,
              default: parameter.defaultValue,
              required: parameter.required,
            })),
          }
        : {}),
    },
    { lineWidth: 0 }
  ).trimEnd();
  return `---\n${frontmatter}\n---\n\n${definition.body.trimEnd()}\n`;
}

export function parseSkillSource(source: string): SkillSourceDefinition {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/);
  if (!match) {
    throw new SkillValidationError('Skill 文件必须包含 YAML frontmatter。');
  }
  let value: unknown;
  try {
    value = parse(match[1]);
  } catch (error) {
    throw new SkillValidationError(`Frontmatter 解析失败：${error instanceof Error ? error.message : '未知错误'}`);
  }
  if (!isRecord(value)) {
    throw new SkillValidationError('Frontmatter 必须是对象。');
  }
  const unknown = Object.keys(value).filter((key) => !ALLOWED_KEYS.has(key));
  if (unknown.length) {
    throw new SkillValidationError(`不支持的 frontmatter 字段：${unknown.join(', ')}。`);
  }
  if (value['allowed-tools'] !== undefined && !isStringArray(value['allowed-tools'])) {
    throw new SkillValidationError('allowed-tools 必须是字符串数组。');
  }
  if (value.parameters !== undefined && !Array.isArray(value.parameters)) {
    throw new SkillValidationError('parameters 必须是数组。');
  }
  return {
    name: stringValue(value.name),
    description: stringValue(value.description),
    slashCommand: stringValue(value['slash-command']),
    allowedTools: isStringArray(value['allowed-tools']) ? value['allowed-tools'] : [],
    timeout: stringValue(value.timeout) || '60s',
    parameters: Array.isArray(value.parameters) ? value.parameters.map(parseParameter) : [],
    body: match[2].replace(/^\r?\n/, '').trimEnd(),
  };
}

function parseParameter(value: unknown): SkillParameter {
  if (!isRecord(value)) {
    throw new SkillValidationError('每个 parameter 必须是对象。');
  }
  return {
    name: stringValue(value.name),
    type: value.type === 'number' || value.type === 'bool' ? value.type : 'string',
    description: stringValue(value.description),
    defaultValue: stringValue(value.default),
    required: value.required === true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function stringValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
