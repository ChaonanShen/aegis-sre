import { parse } from 'yaml';
import { PlaybookParameter, PlaybookStep, PlaybookStepType } from './model';
import { PlaybookValidationError } from './errors';

/** 只把原生 Dagu YAML 投影为 UI 模型，不生成或改写 YAML。 */
export interface DaguProjection {
  name: string;
  description: string;
  parameters: PlaybookParameter[];
  steps: PlaybookStep[];
}

export function projectDaguSource(source: string): DaguProjection {
  let value: unknown;
  try {
    value = parse(source);
  } catch (error) {
    throw new PlaybookValidationError(`Dagu YAML 解析失败：${error instanceof Error ? error.message : '未知错误'}`);
  }
  const dag = asRecord(value);
  if (!dag) {
    throw new PlaybookValidationError('Dagu YAML 顶层必须是对象。');
  }
  if (!Array.isArray(dag.steps)) {
    throw new PlaybookValidationError('Dagu YAML 必须包含 steps 数组。');
  }
  const steps = dag.steps.map(projectStep);
  const name = stringValue(dag.name) || 'unnamed-playbook';
  return {
    name,
    description: stringValue(dag.description),
    parameters: projectParams(dag.params),
    steps,
  };
}

function projectStep(value: unknown, index: number): PlaybookStep {
  const step = asRecord(value);
  if (!step) {
    throw new PlaybookValidationError(`Dagu Step ${index + 1} 必须是对象。`);
  }
  const id = stringValue(step.id || step.name || `step_${index + 1}`);
  const action = stringValue(step.action);
  const run = stringValue(step.run);
  const depends = step.depends ?? step.dependsOn;
  return {
    id,
    label: stringValue(step.name) || id.replaceAll('_', ' '),
    dependsOn: Array.isArray(depends) ? depends.map(stringValue) : depends ? [stringValue(depends)] : [],
    type: stepType(action, run, step),
    config: { ...step },
    sideEffect: action === 'human.task' || Boolean(step.approval),
    dryRun: false,
  };
}

function stepType(action: string, run: string, step: Record<string, unknown>): PlaybookStepType {
  if (action === 'mcp.call') {
    return 'mcp_call';
  }
  if (action === 'human.task' || step.approval) {
    return 'branch';
  }
  if (step.parallel) {
    return 'parallel';
  }
  if (step.repeat_policy || step.foreach) {
    return 'loop';
  }
  if (action === 'template.render') {
    return 'template';
  }
  return action.startsWith('jq.') || action.startsWith('http.') || run ? 'query' : 'query';
}

function projectParams(value: unknown): PlaybookParameter[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      if (typeof item === 'string') {
        const [name, defaultValue = ''] = item.split(':', 2);
        return name.trim() ? [{ name: name.trim(), type: 'string' as const, defaultValue: defaultValue.trim(), required: false }] : [];
      }
      const param = asRecord(item);
      const name = stringValue(param?.name);
      return name ? [{ name, type: paramType(param?.type), defaultValue: stringValue(param?.default), required: false }] : [];
    });
  }
  const schema = asRecord(value);
  const properties = asRecord(schema?.properties) ?? {};
  const required = new Set(Array.isArray(schema?.required) ? schema.required.map(stringValue) : []);
  return Object.entries(properties).flatMap(([name, raw]) => {
    const property = asRecord(raw);
    if (!property) {
      return [];
    }
    return [{ name, type: paramType(property.type), defaultValue: stringValue(property.default), required: required.has(name) }];
  });
}

function paramType(value: unknown): PlaybookParameter['type'] {
  return value === 'integer' || value === 'number' ? 'number' : value === 'boolean' ? 'bool' : 'string';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
