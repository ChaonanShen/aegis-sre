import { SkillValidationError } from './errors';
import { parseSkillSource, serializeSkillSource, SkillSourceDefinition } from './skillSource';

describe('skillSource', () => {
  test('round-trips Go-compatible frontmatter and Markdown', () => {
    const definition: SkillSourceDefinition = {
      name: 'checkout-troubleshoot',
      description: 'Checkout 服务排查',
      slashCommand: '/check-cart',
      allowedTools: ['grafana_mcp/query_prometheus'],
      timeout: '60s',
      parameters: [
        {
          name: 'env',
          type: 'string',
          description: '目标环境',
          defaultValue: 'production',
          required: true,
        },
      ],
      body: '# Checkout\n\n1. 查询 p95',
    };

    expect(parseSkillSource(serializeSkillSource(definition))).toEqual(definition);
  });

  test('keeps visibility, folder, and owner outside author frontmatter', () => {
    const source = serializeSkillSource({
      name: 'private-debug',
      description: 'Private',
      slashCommand: '/private-debug',
      allowedTools: [],
      timeout: '2m',
      parameters: [],
      body: '# Private',
    });

    expect(source).not.toMatch(/visibility|folder|owner/);
  });

  test('rejects unknown metadata and malformed tool lists', () => {
    expect(() => parseSkillSource('---\nname: sample\nowner: alice\n---\n# Sample')).toThrow(
      SkillValidationError
    );
    expect(() =>
      parseSkillSource('---\nname: sample\nallowed-tools: grafana/query\n---\n# Sample')
    ).toThrow(/字符串数组/);
  });
});
