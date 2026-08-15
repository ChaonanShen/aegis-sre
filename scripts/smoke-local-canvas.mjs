#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const port = process.env.GRAFANA_PORT ?? '3000';
const passwordFile = process.env.GRAFANA_ADMIN_PASSWORD_FILE ?? 'deploy/local/secrets/grafana-admin-password';
const datasourceUID = process.env.CANVAS_SMOKE_PROMETHEUS_UID;
if (!datasourceUID) {
  throw new Error('set CANVAS_SMOKE_PROMETHEUS_UID to a real Prometheus datasource UID');
}
const password = readFileSync(passwordFile, 'utf8').trim();
const base = `http://127.0.0.1:${port}/api/plugins/grafana-plugin-app/resources/api/v1`;
const commonHeaders = {
  Authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`,
  'Content-Type': 'application/json',
};
const operationID = (kind) => `${kind}-${randomUUID()}`;

async function readJSON(response, operation) {
  const text = await response.text();
  if (!response.ok) throw new Error(`${operation} returned HTTP ${response.status}: ${text}`);
  return text ? JSON.parse(text) : undefined;
}

const session = await readJSON(
  await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: { ...commonHeaders, 'Idempotency-Key': operationID('canvas-session') },
    body: JSON.stringify({ title: 'Local Canvas persistence smoke' }),
  }),
  'create Canvas smoke session'
);
let failure;
try {
  const message = `请使用 Prometheus datasource UID ${datasourceUID} 查询过去 15 分钟的 up 指标，并生成一个时序图。查询成功后必须调用 Canvas 发布工具保存图表。`;
  const response = await fetch(`${base}/sessions/${encodeURIComponent(session.id)}/turns:stream`, {
    method: 'POST',
    headers: { ...commonHeaders, Accept: 'text/event-stream', 'Idempotency-Key': operationID('canvas-turn') },
    body: JSON.stringify({ message, mentions: [] }),
    signal: AbortSignal.timeout(120_000),
  });
  const stream = await response.text();
  if (!response.ok || !stream.includes('event: turn.completed')) {
    throw new Error(`Canvas agent turn did not complete: HTTP ${response.status} ${stream.slice(-1000)}`);
  }
  const canvas = await readJSON(
    await fetch(`${base}/sessions/${encodeURIComponent(session.id)}/canvas`, { headers: commonHeaders }),
    'read persisted Canvas'
  );
  if (canvas.revision < 1 || canvas.items.length < 1 || !canvas.items[0].chart.query.expression) {
    throw new Error(`Canvas projection contains no persisted query-backed chart: ${JSON.stringify(canvas)}`);
  }
  console.log(`Canvas E2E passed: ${session.id} revision=${canvas.revision} chart=${canvas.items[0].chart.id}`);
} catch (error) {
  failure = error;
} finally {
  try {
    await readJSON(await fetch(`${base}/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE', headers: commonHeaders }), 'delete Canvas smoke session');
  } catch (error) {
    failure ??= error;
  }
}
if (failure) throw failure;
