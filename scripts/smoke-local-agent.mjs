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
  if (!stream.includes('event: turn.completed') || !stream.includes('AEGIS_OK')) {
    throw new Error(
      stream.includes('event: turn.failed')
        ? 'DeepSeek turn failed; inspect the OpenCode provider logs'
        : 'turn stream did not contain the terminal event and expected DeepSeek output'
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
