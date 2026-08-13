import { Playbook, PlaybookData, PlaybookDefinition, PlaybookStep } from '../model';

const checkoutSteps: PlaybookStep[] = [
  step('baseline_p95', 'query', '查基线 p95', [], {
    dialect: 'promql',
    datasource: 'prometheus-prod',
    expr: 'histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))',
    output: 'p95_value',
  }),
  step('check_errors', 'query', '查错误率', [], {
    dialect: 'promql',
    datasource: 'prometheus-prod',
    expr: 'sum(rate(http_requests_total{status=~"5.."}[5m]))',
    output: 'error_rate',
  }),
  step('if_errors_high', 'branch', '错误率高？', ['check_errors'], { condition: 'error_rate > 0.01' }),
  step(
    'query_pg_pool',
    'mcp_call',
    '查 PG 连接池',
    ['if_errors_high'],
    { server: 'grafana', tool: 'query_prometheus', args: { expr: 'pg_stat_activity_count' } },
    false
  ),
  step(
    'check_downstream',
    'mcp_call',
    '查下游 trace',
    ['query_pg_pool'],
    { server: 'grafana', tool: 'query_tempo', args: { service: 'checkout-api', timeRange: '30m' } },
    true
  ),
  step('summarize', 'template', '汇总报告', ['check_downstream'], {
    template: '## 排查结果\n\n{{ .steps }}',
  }),
];

export const playbookFixtureData: PlaybookData = {
  schemaVersion: 1,
  playbooks: [
    playbook(
      'pb-001',
      {
        name: 'checkout-latency-investigation',
        description: 'Checkout 服务 p95 延迟升高的结构化排查',
        version: '1.3',
        trigger: { type: 'alert', pattern: 'CheckoutLatencyHigh', alertLabels: {} },
        parameters: [{ name: 'env', type: 'string', defaultValue: 'production', required: true }],
        steps: checkoutSteps,
        experience: [
          {
            author: 'alice',
            date: '2026-06-23T08:00:00.000Z',
            body: '真实事故发现 PG 连接池满比 latency 早告警 5-10min，可加 query。',
          },
          { author: 'bob', date: '2026-07-02T08:00:00.000Z', body: '补充了下游 trace 查询步骤。' },
        ],
        visibility: 'shared',
        folderUid: 'payment',
      },
      'alice',
      27,
      3
    ),
    playbook(
      'pb-002',
      definition('pg-connection-pool-debug', 'PG 连接池满诊断', '1.0', 'shared', 'infra', [
        step('query_connections', 'query', '检查连接数', [], {
          dialect: 'promql',
          datasource: 'prometheus-prod',
          expr: 'pg_stat_activity_count',
        }),
      ]),
      'bob',
      12
    ),
    playbook(
      'pb-003',
      definition('search-qps-diagnosis', 'Search QPS 异常下降诊断', '1.1', 'shared', 'search', [
        step('query_qps', 'query', '检查 Search QPS', [], {
          dialect: 'promql',
          datasource: 'prometheus-prod',
          expr: 'sum(rate(search_requests_total[5m]))',
        }),
      ]),
      'carol',
      8
    ),
    playbook(
      'pb-004',
      definition('private-incident-2026-07-21', '我上周的告警排查（私有）', '0.1', 'private', undefined, [
        step('review', 'template', '整理事故记录', [], { template: '# Incident review' }),
      ]),
      'alice',
      2
    ),
    playbook(
      'pb-005',
      definition('order-shipping-delay', '订单发货延迟排查', '1.0', 'shared', 'payment', [
        step('shipping_delay', 'query', '检查发货延迟', [], {
          dialect: 'promql',
          datasource: 'prometheus-prod',
          expr: 'shipping_delay_seconds',
        }),
      ]),
      'dave',
      5
    ),
    playbook(
      'pb-006',
      definition('order-shipping-delay-v2', '订单发货延迟排查 v2（待晋升）', '0.2', 'private', undefined, [
        step('shipping_queue', 'query', '检查发货队列', [], {
          dialect: 'promql',
          datasource: 'prometheus-prod',
          expr: 'shipping_queue_depth',
        }),
      ]),
      'dave',
      8
    ),
    playbook(
      'pb-007',
      definition('search-qps-anomaly-v3', 'Search QPS 异常排查 v3（已拒绝）', '0.3', 'private', undefined, [
        step('search_qps', 'query', '检查 Search QPS', [], {
          dialect: 'promql',
          datasource: 'prometheus-prod',
          expr: 'sum(rate(search_requests_total[5m]))',
        }),
      ]),
      'carol',
      3
    ),
    playbook(
      'pb-008',
      definition('search-index-lag-review', 'Search 索引延迟排查（待晋升）', '0.1', 'private', undefined, [
        step('index_lag', 'query', '检查索引延迟', [], {
          dialect: 'promql',
          datasource: 'prometheus-prod',
          expr: 'search_index_lag_seconds',
        }),
      ]),
      'dave',
      6
    ),
  ],
  drafts: [],
  runs: [],
};

function definition(
  name: string,
  description: string,
  version: string,
  visibility: 'private' | 'shared',
  folderUid: string | undefined,
  steps: PlaybookStep[]
): PlaybookDefinition {
  return {
    name,
    description,
    version,
    trigger: { type: 'manual', alertLabels: {} },
    parameters: [],
    steps,
    experience: [],
    visibility,
    folderUid,
  };
}

function playbook(
  id: string,
  input: PlaybookDefinition,
  ownerId: string,
  usageCount: number,
  recordVersion = 1
): Playbook {
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
        displayVersion: input.version,
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

function step(
  id: string,
  type: PlaybookStep['type'],
  label: string,
  dependsOn: string[],
  config: Record<string, unknown>,
  sideEffect = false
): PlaybookStep {
  return { id, type, label, dependsOn, config, sideEffect, dryRun: sideEffect };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
