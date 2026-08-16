#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const port = process.env.GRAFANA_PORT ?? '3000';
const passwordFile = process.env.GRAFANA_ADMIN_PASSWORD_FILE ?? 'deploy/local/secrets/grafana-admin-password';
const password = readFileSync(passwordFile, 'utf8').trim();
const grafanaBase = `http://127.0.0.1:${port}`;
const base = `http://127.0.0.1:${port}/api/plugins/grafana-plugin-app/resources/api/v1`;
const commonHeaders = {
  Authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`,
  'Content-Type': 'application/json',
};
const operationID = (kind) => `${kind}-${randomUUID()}`;

async function responseText(response, operation) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${operation} returned HTTP ${response.status}: ${text}`);
  }
  return text;
}

function parseServerSentEvents(stream) {
  return stream
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const event = lines.find((line) => line.startsWith('event: '))?.slice('event: '.length);
      const data = lines
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice('data: '.length))
        .join('\n');
      return event && data ? { event, data: JSON.parse(data) } : undefined;
    })
    .filter(Boolean);
}

const settings = JSON.parse(
  await responseText(
    await fetch(`${grafanaBase}/api/plugins/grafana-plugin-app/settings`, { headers: commonHeaders }),
    'read plugin settings'
  )
);
if (settings.jsonData?.workbenchMode === 'fixture') {
  throw new Error('Grafana plugin is still provisioned in fixture mode');
}

const createdText = await responseText(
  await fetch(`${base}/sessions`, {
    method: 'POST',
    headers: { ...commonHeaders, 'Idempotency-Key': operationID('agent-session') },
    body: JSON.stringify({ title: 'Local OpenCode smoke' }),
  }),
  'create session'
);
const session = JSON.parse(createdText);

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 60_000);
let smokeError;
try {
  const stream = await responseText(
    await fetch(`${base}/sessions/${encodeURIComponent(session.id)}/turns:stream`, {
      method: 'POST',
      headers: {
        ...commonHeaders,
        Accept: 'text/event-stream',
        'Idempotency-Key': operationID('agent-turn'),
      },
      body: JSON.stringify({ message: '只回复 AEGIS_OK', mentions: [] }),
      signal: controller.signal,
    }),
    'stream turn'
  );
  const events = parseServerSentEvents(stream);
  // Provider 可把单个回答拆成任意 message.delta，必须按事件语义重组后再断言。
  const assistantOutput = events
    .filter(({ event }) => event === 'message.delta')
    .map(({ data }) => data.payload?.delta ?? '')
    .join('');
  const hasCompleted = events.some(({ event }) => event === 'turn.completed');
  const hasFailed = events.some(({ event }) => event === 'turn.failed');
  const hasExpectedOutput = assistantOutput.includes('AEGIS_OK');
  if (!hasCompleted || !hasExpectedOutput) {
    throw new Error(
      hasFailed
        ? 'DeepSeek turn failed; inspect the OpenCode provider logs'
        : `turn stream validation failed (completed=${hasCompleted}, expected_output=${hasExpectedOutput}): ${stream.slice(-1000)}`
    );
  }

  const detail = await responseText(
    await fetch(`${base}/sessions/${encodeURIComponent(session.id)}`, { headers: commonHeaders }),
    'read session'
  );
  if (!detail.includes('AEGIS_OK')) {
    throw new Error('completed DeepSeek output was not persisted in the native session');
  }
} catch (error) {
  smokeError = error;
} finally {
  clearTimeout(timeout);
  try {
    await responseText(
      await fetch(`${base}/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE', headers: commonHeaders }),
      'delete smoke session'
    );
  } catch (error) {
    smokeError ??= error;
  }
}
if (smokeError) {
  throw smokeError;
}
console.log(`OpenCode agent smoke passed: ${session.id}`);
