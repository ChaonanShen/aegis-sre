const { parse, stringify } = require('yaml') as typeof import('yaml');
import { PlaybookDefinition, PlaybookParameter, PlaybookStep } from './model';
import { PlaybookValidationError } from './errors';

const ALLOWED_KEYS = new Set([
  'name',
  'description',
  'version',
  'trigger',
  'parameters',
  'steps',
  'experience',
  'visibility',
  'folder_uid',
]);

export function serializePlaybook(definition: PlaybookDefinition): string {
  return stringify(
    {
      name: definition.name,
      description: definition.description,
      version: definition.version,
      trigger: {
        type: definition.trigger.type,
        ...(definition.trigger.pattern ? { pattern: definition.trigger.pattern } : {}),
        ...(Object.keys(definition.trigger.alertLabels).length ? { alert_labels: definition.trigger.alertLabels } : {}),
      },
      parameters: definition.parameters.map((parameter) => ({
        name: parameter.name,
        type: parameter.type,
        default: parameter.defaultValue,
        required: parameter.required,
      })),
      steps: definition.steps.map((step) => ({
        id: step.id,
        type: step.type,
        label: step.label,
        ...(step.dependsOn.length ? { depends_on: step.dependsOn } : {}),
        config: step.config,
        ...(step.expect ? { expect: { expression: step.expect.expression, on_fail: step.expect.onFail } } : {}),
        ...(step.sideEffect ? { side_effect: true } : {}),
        ...(step.dryRun ? { dry_run: true } : {}),
      })),
      experience: definition.experience,
      visibility: definition.visibility,
      ...(definition.folderUid ? { folder_uid: definition.folderUid } : {}),
    },
    { lineWidth: 0 }
  );
}

export function parsePlaybookSource(source: string): PlaybookDefinition {
  let value: unknown;
  try {
    value = parse(source);
  } catch (error) {
    throw new PlaybookValidationError(`YAML 解析失败：${error instanceof Error ? error.message : '未知错误'}`);
  }
  if (!isRecord(value)) {
    throw new PlaybookValidationError('YAML 顶层必须是对象。');
  }
  const unknown = Object.keys(value).filter((key) => !ALLOWED_KEYS.has(key));
  if (unknown.length) {
    throw new PlaybookValidationError(`不支持的 YAML 字段：${unknown.join(', ')}。`);
  }
  if (!Array.isArray(value.steps) || !Array.isArray(value.parameters)) {
    throw new PlaybookValidationError('steps 和 parameters 必须是数组。');
  }
  const trigger = isRecord(value.trigger) ? value.trigger : {};
  return {
    name: stringValue(value.name),
    description: stringValue(value.description),
    version: stringValue(value.version),
    trigger: {
      type: trigger.type === 'alert' ? 'alert' : 'manual',
      pattern: optionalString(trigger.pattern),
      alertLabels: isStringRecord(trigger.alert_labels) ? trigger.alert_labels : {},
    },
    parameters: (value.parameters as unknown[]).map(parseParameter),
    steps: value.steps.map(parseStep),
    experience: Array.isArray(value.experience)
      ? value.experience.filter(isRecord).map((note) => ({
          author: stringValue(note.author),
          date: stringValue(note.date),
          body: stringValue(note.body),
        }))
      : [],
    visibility: value.visibility === 'shared' ? 'shared' : 'private',
    folderUid: value.visibility === 'shared' ? optionalString(value.folder_uid) : undefined,
  };
}

function parseParameter(value: unknown): PlaybookParameter {
  if (!isRecord(value)) {
    throw new PlaybookValidationError('Parameter 必须是对象。');
  }
  return {
    name: stringValue(value.name),
    type: value.type === 'number' || value.type === 'bool' ? value.type : 'string',
    defaultValue: optionalString(value.default) ?? '',
    required: value.required === true,
  };
}

function parseStep(value: unknown): PlaybookStep {
  if (!isRecord(value) || !isRecord(value.config)) {
    throw new PlaybookValidationError('每个 Step 都必须包含对象类型的 config。');
  }
  const types = new Set(['query', 'branch', 'loop', 'template', 'mcp_call', 'parallel']);
  if (typeof value.type !== 'string' || !types.has(value.type)) {
    throw new PlaybookValidationError(`未知 Step 类型 "${String(value.type)}"。`);
  }
  const expect = isRecord(value.expect)
    ? {
        expression: stringValue(value.expect.expression),
        onFail: value.expect.on_fail === 'continue' ? ('continue' as const) : ('fail' as const),
      }
    : undefined;
  return {
    id: stringValue(value.id),
    type: value.type as PlaybookStep['type'],
    label: stringValue(value.label || value.id),
    dependsOn: Array.isArray(value.depends_on) ? value.depends_on.map(stringValue) : [],
    config: value.config,
    expect,
    sideEffect: value.side_effect === true,
    dryRun: value.dry_run === true || value.side_effect === true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string');
}

function stringValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}

function optionalString(value: unknown): string | undefined {
  const result = stringValue(value).trim();
  return result || undefined;
}
