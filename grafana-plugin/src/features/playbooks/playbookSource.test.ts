import { PlaybookDefinition } from './model';
import { parsePlaybookSource, serializePlaybook } from './playbookSource';

describe('playbook source', () => {
  test('round trips structured content and open step config', () => {
    const source = serializePlaybook(definition());
    expect(parsePlaybookSource(source)).toEqual(definition());
  });

  test('rejects unknown top-level fields instead of silently dropping them', () => {
    expect(() => parsePlaybookSource(`${serializePlaybook(definition())}\nunknown: true`)).toThrow(
      /不支持的 YAML 字段/
    );
  });

  test('reports malformed YAML', () => {
    expect(() => parsePlaybookSource('name: [broken')).toThrow(/YAML 解析失败/);
  });

  test('rejects a missing parameters array without throwing a runtime TypeError', () => {
    expect(() => parsePlaybookSource('steps: []')).toThrow(/steps 和 parameters 必须是数组/);
  });
});

function definition(): PlaybookDefinition {
  return {
    name: 'checkout-check',
    description: 'Checkout check',
    version: '1.0',
    trigger: { type: 'alert', pattern: 'CheckoutHigh', alertLabels: { severity: 'critical' } },
    parameters: [{ name: 'env', type: 'string', defaultValue: 'prod', required: true }],
    steps: [
      {
        id: 'query',
        type: 'query',
        label: 'Query',
        dependsOn: [],
        config: { dialect: 'promql', expr: 'up', nested: { enabled: true } },
        expect: { expression: 'value > 0', onFail: 'fail' },
        sideEffect: false,
        dryRun: false,
      },
    ],
    experience: [{ author: 'alice', date: '2026-07-25', body: 'initial' }],
    visibility: 'shared',
    folderUid: 'payment',
  };
}
