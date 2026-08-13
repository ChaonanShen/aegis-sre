import { AlertData, AlertDetail, AlertPipelineState, AlertStatus } from '../model';

export function createAlertFixtureData(): AlertData {
  const alert = (
    id: string,
    status: AlertStatus,
    severity: AlertDetail['severity'],
    alertName: string,
    service: string,
    folderUid: string,
    summary: string,
    startedAt: string,
    extras: Partial<AlertDetail> = {}
  ): AlertDetail => ({
    id,
    status,
    severity,
    alertName,
    service,
    folderUid,
    summary,
    startedAt,
    receivedAt: new Date(Date.parse(startedAt) + 60000).toISOString(),
    source: id === 'al-003' ? 'grafana' : 'alertmanager',
    fingerprint: `fp-${id.slice(3)}a1b2c3`,
    pipeline: pipeline(status),
    ...extras,
  });
  return {
    schemaVersion: 1,
    alerts: [
      alert(
        'al-001',
        'analyzing',
        'warning',
        'CheckoutLatencyHigh',
        'checkout-api',
        'payment',
        'p95 latency > 500ms for 5m on checkout-api (prod)',
        '2026-07-25T06:23:00.000Z',
        { runId: 'run-9821' }
      ),
      alert(
        'al-002',
        'analyzed',
        'critical',
        'PaymentErrorRate',
        'payment-service',
        'payment',
        '5xx error rate > 5% for 2m',
        '2026-07-25T05:42:00.000Z',
        {
          runId: 'run-9815',
          aiAnalysis:
            'PG connection pool 已满，checkout-api 调用 payment 时连接等待超时。建议先扩容 PG 连接池到 400，临时把 checkout-api replicas 扩到 20。',
          recommendedPlaybookId: 'pb-002',
          recommendedPlaybookName: 'pg-connection-pool-debug',
        }
      ),
      alert(
        'al-003',
        'firing',
        'warning',
        'SearchQPSDrop',
        'search-api',
        'search',
        'search-api QPS 较上周同期下降 30%',
        '2026-07-25T06:15:00.000Z'
      ),
      alert(
        'al-004',
        'resolved',
        'warning',
        'PGConnectionPoolHigh',
        'postgres',
        'infra',
        'PG connection usage > 90%',
        '2026-07-25T05:30:00.000Z'
      ),
      alert(
        'al-005',
        'failed',
        'info',
        'KafkaLagHigh',
        'kafka',
        'infra',
        'Kafka consumer lag > 1000',
        '2026-07-25T04:00:00.000Z',
        {
          failureMessage: 'Loki 数据源 5xx · 3 次重试后放弃',
          retrySummary: '已重试 3 次，并切换到备用模型',
        }
      ),
    ],
  };
}

export function pipeline(status: AlertStatus) {
  const states: Record<AlertStatus, AlertPipelineState[]> = {
    firing: ['ok', 'ok', 'pending', 'pending', 'pending', 'pending'],
    analyzing: ['ok', 'ok', 'running', 'running', 'pending', 'pending'],
    analyzed: ['ok', 'ok', 'ok', 'ok', 'ok', 'ok'],
    resolved: ['ok', 'ok', 'ok', 'ok', 'ok', 'ok'],
    failed: ['ok', 'ok', 'ok', 'error', 'error', 'error'],
  };
  const labels = [
    ['webhook', '接收告警', '签名校验'],
    ['idempotency', '检查重复', '自动合并重复事件'],
    ['scheduler', '任务调度', '后台处理'],
    ['agent', '智能分析', '调用调查工具'],
    ['playbook', '处置流程', '结构化排查'],
    ['result', '分析结果', '生成报告'],
  ];
  return labels.map(([id, label, description], index) => ({ id, label, description, state: states[status][index] }));
}
