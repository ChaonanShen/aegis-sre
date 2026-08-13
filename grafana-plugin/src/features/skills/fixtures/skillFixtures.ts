import { Skill, SkillData, SkillDefinition } from '../model';

export const skillFixtureData: SkillData = {
  schemaVersion: 1,
  skills: [
    skill(
      'sk-001',
      definition(
        'checkout-troubleshoot',
        'Checkout 服务健康检查与故障排查',
        '/check-cart',
        ['grafana_mcp/query_prometheus', 'grafana_mcp/query_loki', 'grafana_mcp/query_tempo'],
        ['oncall', 'p0', 'checkout'],
        `# Checkout 服务健康检查

按以下顺序检查：

1. 查 p95 latency
2. 查错误率
3. 如果错误率高，查 Loki 错误日志
4. 列出可疑下游服务

每步用 Grafana MCP 工具查询，结果汇总到 Markdown 报告。`,
        'shared',
        'payment'
      ),
      'alice',
      142,
      3
    ),
    skill(
      'sk-002',
      definition(
        'p95-trace',
        'p95 延迟链路追踪',
        '/p95-trace',
        ['grafana_mcp/query_tempo'],
        ['trace', 'p95'],
        '# p95 延迟链路追踪',
        'shared',
        'shared'
      ),
      'bob',
      67
    ),
    skill(
      'sk-003',
      definition(
        'rollback-checkout',
        '紧急回滚 checkout 服务',
        '/rollback-cart',
        ['grafana_mcp/update_dashboard'],
        ['rollback', 'p0'],
        '# 紧急回滚 checkout 服务',
        'shared',
        'payment'
      ),
      'alice',
      23
    ),
    skill(
      'sk-004',
      definition(
        'my-personal-debug',
        '我自己的排查模板（私有）',
        '/my-debug',
        [],
        ['personal'],
        '# My Personal Debug Template',
        'private'
      ),
      'alice',
      5
    ),
    skill(
      'sk-005',
      definition(
        'pg-pool-quickcheck',
        'PG 连接池快速检查',
        '/pg-pool-check',
        ['grafana_mcp/query_prometheus'],
        ['postgres', 'quickcheck'],
        '# PG Pool Quickcheck',
        'shared',
        'infra'
      ),
      'bob',
      15
    ),
  ],
  runs: [],
};

function definition(
  name: string,
  description: string,
  slashCommand: string,
  allowedTools: string[],
  tags: string[],
  body: string,
  visibility: SkillDefinition['visibility'],
  folderUid?: string
): SkillDefinition {
  return {
    name,
    description,
    slashCommand,
    allowedTools,
    timeout: '60s',
    parameters: [],
    tags,
    body,
    visibility,
    folderUid,
  };
}

function skill(
  id: string,
  input: SkillDefinition,
  ownerId: string,
  usageCount: number,
  recordVersion = 1
): Skill {
  const savedAt = '2026-07-25T03:00:00.000Z';
  return {
    ...input,
    id,
    ownerId,
    usageCount,
    recordVersion,
    latestChangeNote: '初始版本',
    revisions: [
      {
        revision: recordVersion,
        author: ownerId,
        savedAt,
        changeNote: '初始版本',
        snapshot: clone(input),
      },
    ],
    createdAt: '2026-07-20T02:00:00.000Z',
    updatedAt: savedAt,
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
