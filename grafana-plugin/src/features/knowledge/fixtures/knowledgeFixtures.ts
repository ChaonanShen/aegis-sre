import { fixtureFolderPermissions } from '../../../app/fixtures/folderFixtures';
import { FolderPermissionMap, KnowledgeData } from '../model';

export const knowledgeFixturePermissions: FolderPermissionMap = fixtureFolderPermissions;

export const knowledgeFixtureData: KnowledgeData = {
  schemaVersion: 1,
  services: [
    service('svc-001', 'payment', 'checkout-api', 'Checkout API', 'payments-team', 'critical', [
      ['p95_latency', 'histogram_quantile(0.95, ...)', '< 500ms'],
      ['error_rate', 'sum(rate(http_requests_total{status=~"5.."}[5m]))', '< 1%'],
      ['qps', 'sum(rate(http_requests_total[5m]))', '-'],
    ]),
    service('svc-002', 'payment', 'payment-service', 'Payment Service', 'payments-team', 'critical', [
      ['success_rate', 'sum(rate(payment_success[5m])) / sum(rate(payment_total[5m]))', '> 99%'],
    ]),
    service('svc-003', 'payment', 'order-service', 'Order Service', 'orders-team', 'standard', [
      ['latency', 'histogram_quantile(0.95, ...)', '-'],
    ]),
    service('svc-004', 'search', 'search-api', 'Search API', 'search-team', 'standard', [
      ['qps', 'sum(rate(search_requests_total[5m]))', '> 2k'],
    ]),
    service('svc-005', 'infra', 'postgres', 'PostgreSQL', 'database-team', 'critical', [
      ['connections', 'pg_stat_activity_count', '< 360'],
    ]),
    service('svc-006', 'infra', 'kafka', 'Kafka', 'platform-team', 'standard', [
      ['consumer_lag', 'kafka_consumergroup_lag', '< 10k'],
    ]),
    service('svc-007', 'shared', 'observability', 'Shared Observability', 'sre-team', 'standard', []),
    service('svc-008', 'biz', 'billing-report', 'Billing Report', 'finance-platform', 'low', []),
  ],
  runbooks: [
    runbook(
      'rb-001',
      'payment',
      'Checkout 服务 p95 延迟升高排查',
      'svc-001',
      ['latency', 'oncall', 'p0'],
      'warning',
      'alice',
      'manual',
      '收到 checkout p95 > 500ms 告警后的标准排查流程...',
      `# Checkout 服务 p95 延迟升高排查

## 现象
- p95 latency > 500ms
- 错误率正常（< 1%）
- 持续 5 分钟

## 排查步骤
1. 确认影响范围和 region
2. 检查 payment-service、order-service 和 PG 连接池
3. 使用 /check-cart 运行全链路检查

## 经验
PG 连接池满通常比 latency 告警早 5-10 分钟。`
    ),
    runbook(
      'rb-002',
      'infra',
      'PG 连接池满诊断',
      'svc-005',
      ['pg', 'connection', 'p1'],
      'critical',
      'bob',
      'imported',
      'PG max connection 达到上限后的诊断流程...',
      '# PG 连接池满诊断\n\n1. 检查 active connections\n2. 排查慢查询\n3. 临时扩容连接池'
    ),
    runbook(
      'rb-003',
      'search',
      'Search 索引重建 SOP',
      'svc-004',
      ['search', 'indexing'],
      'info',
      'carol',
      'manual',
      '搜索索引重建的标准流程...',
      '# Search 索引重建 SOP\n\n按 region 滚动重建索引。'
    ),
  ],
  documents: [
    document('doc-001', 'payment', 'checkout-p95-investigation.pdf', 'pdf', 812_000, 12, 'alice'),
    document('doc-002', 'infra', 'pg-tuning-guide.docx', 'docx', 420_000, 24, 'bob', 'svc-005'),
    document('doc-003', 'shared', 'oncall-handbook.md', 'md', 28_000, 8, 'carol'),
  ],
  imports: [
    importTask('imp-001', 'payment', 'reviewing', 80, 4, 1, 'alice'),
    importTask('imp-002', 'infra', 'parsing', 35, 2, 0, 'alice'),
    importTask('imp-003', 'search', 'done', 100, 3, 0, 'carol'),
  ],
};

function service(
  id: string,
  folderUid: string,
  name: string,
  displayName: string,
  owner: string,
  tier: 'critical' | 'standard' | 'low',
  metrics: Array<[string, string, string]>
) {
  return {
    id,
    folderUid,
    name,
    displayName,
    owner,
    tier,
    keyMetrics: metrics.map(([metricName, expr, threshold]) => ({ name: metricName, expr, threshold })),
    runbookCount: name === 'checkout-api' ? 5 : name === 'payment-service' ? 3 : metrics.length ? 1 : 0,
    playbookCount: name === 'checkout-api' ? 3 : name === 'payment-service' ? 2 : name === 'search-api' ? 1 : 0,
    version: 3,
    createdAt: '2026-07-20T02:00:00.000Z',
    updatedAt: '2026-07-25T03:02:00.000Z',
  };
}

function runbook(
  id: string,
  folderUid: string,
  title: string,
  serviceId: string,
  tags: string[],
  severity: 'info' | 'warning' | 'critical',
  author: string,
  source: 'manual' | 'imported',
  excerpt: string,
  body: string
) {
  return {
    id,
    folderUid,
    title,
    serviceId,
    tags,
    severity,
    author,
    source,
    excerpt,
    body,
    version: 1,
    history: [],
    createdAt: '2026-07-20T02:00:00.000Z',
    updatedAt: '2026-07-25T02:42:00.000Z',
  };
}

function document(
  id: string,
  folderUid: string,
  name: string,
  format: 'md' | 'pdf' | 'docx',
  sizeBytes: number,
  chunks: number,
  importedBy: string,
  serviceId?: string
) {
  return {
    id,
    folderUid,
    name,
    format,
    sizeBytes,
    chunks,
    tags: ['oncall'],
    serviceId,
    importedBy,
    preview: `${name} 的内容预览将在处理完成后显示。`,
    version: 1,
    createdAt: '2026-07-24T02:00:00.000Z',
    updatedAt: '2026-07-24T02:00:00.000Z',
  };
}

function importTask(
  id: string,
  folderUid: string,
  status: 'parsing' | 'reviewing' | 'done',
  progress: number,
  files: number,
  failed: number,
  importedBy: string
) {
  return {
    id,
    folderUid,
    status,
    progress,
    files,
    failed,
    importedBy,
    candidates: [],
    createdDocumentIds: [],
    startedAt: '2026-07-25T02:30:00.000Z',
    updatedAt: '2026-07-25T02:35:00.000Z',
  };
}
