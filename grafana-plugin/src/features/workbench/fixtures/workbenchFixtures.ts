import { OpenedSession, SavedChartPreview, WorkbenchContext, WorkbenchMessage } from '../model';
import { Folder } from '../../../app/model';

export const fixtureFolders: Folder[] = [
  { uid: 'shared', title: 'Shared', permission: 'View', serviceCount: 12 },
  { uid: 'payment', title: 'Payment', permission: 'Edit', serviceCount: 8 },
  { uid: 'search', title: 'Search', permission: 'Admin', serviceCount: 6 },
  { uid: 'infra', title: 'Infra', permission: 'View', serviceCount: 5 },
  { uid: 'biz', title: 'Biz', permission: 'View', serviceCount: 4 },
];

export const defaultCanvasCharts: SavedChartPreview[] = [
  {
    id: 'chart-p95',
    title: 'p95 latency (7d)',
    description: 'checkout-api p95 latency compared with the previous week',
    visualization: 'line',
    renderMode: 'fixture',
  },
  {
    id: 'chart-errors',
    title: '错误率（5xx）',
    description: 'checkout-api 5xx error rate compared with baseline',
    visualization: 'line',
    renderMode: 'fixture',
  },
  {
    id: 'chart-pg',
    title: '下游 PG 连接池',
    description: 'postgres connection pool utilization',
    visualization: 'gauge',
    renderMode: 'fixture',
  },
  {
    id: 'chart-stat',
    title: '当前状态 (stat)',
    description: 'current p95 compared with last week',
    visualization: 'stat',
    renderMode: 'fixture',
  },
];

const initialMessages: WorkbenchMessage[] = [
  {
    id: 'm-1',
    role: 'user',
    content: '@checkout-api 这周 p95 latency 怎么样？',
    mentions: ['@checkout-api'],
  },
  {
    id: 'm-2',
    role: 'tool',
    content: '',
    toolCalls: [
      {
        id: 'tc-1',
        server: 'grafana',
        tool: 'query_prometheus',
        tier: 'read',
        args: 'expr: histogram_quantile(0.95, sum by (le) (rate(http_requests_duration_seconds_bucket{job="checkout-api"}[5m])))',
        result: '本周 p95: 320ms  上周: 280ms  diff: +14%',
        status: 'ok',
        durationMs: 1240,
      },
    ],
  },
  {
    id: 'm-3',
    role: 'assistant',
    content:
      '### 首轮结果\n\n- 本周 p95 中位数：**320ms**\n- 上周同期：280ms\n- 差异：**+14%**（偏离趋势）\n\np95 在 14:18 左右出现明显抬升。我会继续关联错误率和下游依赖，确认是否来自真实故障。',
    streamStatus: 'complete',
  },
  {
    id: 'm-4',
    role: 'user',
    content: '继续查错误率和 PostgreSQL 连接池，给我一个可以行动的结论。',
  },
  {
    id: 'm-5',
    role: 'tool',
    content: '',
    toolCalls: [
      {
        id: 'tc-2',
        server: 'grafana',
        tool: 'query_prometheus',
        tier: 'read',
        args: 'expr: sum(rate(http_requests_total{job="checkout-api",status=~"5.."}[5m])) / sum(rate(http_requests_total{job="checkout-api"}[5m]))',
        result: '14:18 峰值 0.42%，当前 0.08%，历史基线 0.10%',
        status: 'ok',
        durationMs: 680,
      },
      {
        id: 'tc-3',
        server: 'grafana',
        tool: 'query_prometheus',
        tier: 'read',
        args: 'expr: pgxpool_acquired_conns{service="checkout-api"} / pgxpool_max_conns{service="checkout-api"}',
        result: '连接池峰值 88%，当前 61%；峰值时间与 p95 抬升重合',
        status: 'ok',
        durationMs: 910,
      },
    ],
  },
  {
    id: 'm-6',
    role: 'assistant',
    content:
      '### 关联结论\n\n| 指标 | 当前 | 峰值 | 判断 |\n| --- | ---: | ---: | --- |\n| p95 latency | 320ms | 480ms | 高于周基线 14% |\n| 5xx 错误率 | 0.08% | 0.42% | 已恢复 |\n| PG 连接池 | 61% | 88% | 与延迟峰值同窗 |\n\n**最可能原因**是 PostgreSQL 连接池在流量抬升时接近上限，造成请求排队；没有证据表明应用持续失败。\n\n建议先检查 14:15-14:25 的慢查询，并给连接池饱和度增加 `> 80% 持续 5 分钟` 告警，再决定是否扩容。',
    streamStatus: 'complete',
  },
];

export const seededSessions: OpenedSession[] = [
  createSeedSession({
    id: 's-001',
    title: 'Checkout 服务 p95 延迟排查',
    folderUid: 'payment',
    folderTitle: 'Payment',
    visibility: 'team',
    updatedAt: '2026-08-04T05:42:00.000Z',
    preview: 'PG 连接池峰值与 p95 抬升时间重合...',
    messages: initialMessages,
    charts: defaultCanvasCharts,
  }),
  createSeedSession({
    id: 's-002',
    title: '上周三告警复盘',
    folderUid: 'payment',
    folderTitle: 'Payment',
    visibility: 'private',
    updatedAt: '2026-08-04T03:28:00.000Z',
    preview: '告警触发后 12 分钟恢复，已整理时间线...',
    messages: shortConversation(
      '复盘上周三 checkout-api 的高延迟告警。',
      '已整理告警时间线：14:16 连接池饱和，14:18 p95 触顶，14:28 指标恢复。未发生持续错误。'
    ),
  }),
  createSeedSession({
    id: 's-003',
    title: 'Search QPS 异常下降分析',
    folderUid: 'search',
    folderTitle: 'Search',
    visibility: 'team',
    updatedAt: '2026-08-03T08:20:00.000Z',
    preview: 'QPS 在发布后下降 23%，缓存命中率同步回落...',
    messages: shortConversation(
      'Search QPS 为什么在发布后下降？',
      'QPS 下降 23%，但入口流量不变；缓存命中率同时从 91% 降到 74%，建议先核对新版本缓存键。'
    ),
  }),
  createSeedSession({
    id: 's-004',
    title: '新人入职 Onboarding（Forked）',
    folderUid: 'shared',
    folderTitle: 'Shared',
    visibility: 'team',
    forkedFrom: 's-002',
    updatedAt: '2026-08-02T02:15:00.000Z',
    preview: '从已有排查会话创建的分支…',
    messages: shortConversation(
      '把告警复盘整理成新人可执行的检查清单。',
      '已拆成四步：确认影响面、对齐时间窗口、关联依赖指标、记录结论和后续动作。'
    ),
  }),
  createSeedSession({
    id: 's-005',
    title: 'PostgreSQL 连接池诊断',
    folderUid: 'infra',
    folderTitle: 'Infra',
    visibility: 'private',
    status: 'archived',
    updatedAt: '2026-07-31T09:10:00.000Z',
    preview: 'PG max connection 频繁接近阈值，已完成容量评估...',
    messages: shortConversation(
      '检查 PostgreSQL 连接池是否需要扩容。',
      '过去 7 天仅有两个短时峰值，建议先治理慢查询并增加饱和告警，暂不直接扩容。'
    ),
  }),
];

export function contextFor(folderUid: string): WorkbenchContext {
  const activeFolder = fixtureFolders.find(({ uid }) => uid === folderUid) ?? fixtureFolders[3];
  const sharedFolder = fixtureFolders[0];
  const services: Record<string, WorkbenchContext['injectedServices']> = {
    payment: [
      { name: 'checkout-api', folderUid: 'payment', tier: 'critical' },
      { name: 'payment-service', folderUid: 'payment', tier: 'critical' },
      { name: 'order-service', folderUid: 'payment', tier: 'standard' },
    ],
    search: [
      { name: 'search-api', folderUid: 'search', tier: 'standard' },
      { name: 'indexer', folderUid: 'search', tier: 'standard' },
    ],
    infra: [
      { name: 'postgres', folderUid: 'infra', tier: 'critical' },
      { name: 'kafka', folderUid: 'infra', tier: 'standard' },
    ],
    shared: [{ name: 'shared-skill-1', folderUid: 'shared', tier: 'standard' }],
    biz: [],
  };

  return {
    activeFolder,
    sharedFolder,
    injectedServices: services[activeFolder.uid] ?? [],
    skills: [
      { name: '/check-cart', description: 'Checkout 服务健康检查' },
      { name: '/p95-trace', description: 'p95 延迟链路追踪' },
    ],
    recent: [
      { type: 'playbook', name: 'checkout-latency-investigation' },
      { type: 'runbook', name: 'PG 连接池排查' },
    ],
    cost: {
      llmCalls: 4,
      toolRounds: 6,
      maxToolRounds: 20,
      tokensIn: '3.2k',
      tokensOut: '1.1k',
      latency: '4.2s',
    },
  };
}

function createSeedSession(input: {
  id: string;
  title: string;
  folderUid: string;
  folderTitle: string;
  visibility: 'private' | 'team';
  updatedAt: string;
  preview: string;
  forkedFrom?: string;
  status?: 'active' | 'archived';
  messages?: WorkbenchMessage[];
  charts?: SavedChartPreview[];
}): OpenedSession {
  const messages = input.messages ?? [];
  return {
    session: {
      id: input.id,
      title: input.title,
      folderUid: input.folderUid,
      folderTitle: input.folderTitle,
      status: input.status ?? 'active',
      visibility: input.visibility,
      forkedFrom: input.forkedFrom,
      updatedAt: input.updatedAt,
      messageCount: messages.length,
      preview: input.preview,
    },
    messages,
    canvas: {
      visible: true,
      layout: 'grid-2x2',
      charts: input.charts ?? [],
    },
  };
}

function shortConversation(prompt: string, answer: string): WorkbenchMessage[] {
  return [
    { id: `fixture-user-${prompt}`, role: 'user', content: prompt },
    { id: `fixture-assistant-${prompt}`, role: 'assistant', content: answer, streamStatus: 'complete' },
  ];
}
