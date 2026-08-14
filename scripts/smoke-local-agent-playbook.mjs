#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const port = process.env.GRAFANA_PORT ?? '3000';
const password = readFileSync(process.env.GRAFANA_ADMIN_PASSWORD_FILE ?? 'deploy/local/secrets/grafana-admin-password', 'utf8').trim();
const base = `http://127.0.0.1:${port}/api/plugins/grafana-plugin-app/resources/api/v1`;
const authorization = `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`;
const key = (kind) => `${kind}-${randomUUID()}`;

const running = execFileSync('docker', ['compose', 'ps', '--services', '--status', 'running'], { encoding: 'utf8' });
if (running.split(/\r?\n/).includes('ragflow')) {
  throw new Error('RAGFlow is running; Agent + Playbook smoke must not depend on Knowledge');
}

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, { ...options, headers: { Authorization: authorization, ...options.headers } });
  const text = await response.text();
  if (!response.ok) throw new Error(`${options.method ?? 'GET'} ${path} returned HTTP ${response.status}: ${text}`);
  return text ? JSON.parse(text) : undefined;
}

const source = `name: agent-playbook-smoke\ndescription: Agent Playbook MCP smoke\nsteps:\n  - id: report\n    action: template.render\n    with:\n      data: { status: connected }\n      template: 'AEGIS_AGENT_PLAYBOOK_OK: {{ .status }}'\n    stdout:\n      artifact: reports/agent-playbook.txt\n`;
let playbook;
let session;
try {
  playbook = await request('/playbooks', { method: 'POST', headers: { 'Content-Type': 'application/yaml', 'Idempotency-Key': key('playbook') }, body: source });
  session = await request('/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key('agent-session') }, body: JSON.stringify({ title: 'Agent Playbook MCP smoke' }) });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const prompt = `Use the Playbook MCP tools. Start Playbook ${playbook.id} with idempotency_key ${key('agent-run')} in Folder infra, then report the run id. Do not use Knowledge.`;
    const response = await fetch(`${base}/sessions/${encodeURIComponent(session.id)}/turns:stream`, {
      method: 'POST', signal: controller.signal, headers: { Authorization: authorization, Accept: 'text/event-stream', 'Content-Type': 'application/json', 'Idempotency-Key': key('agent-turn') },
      body: JSON.stringify({ message: prompt, mentions: [] }),
    });
    const text = await response.text();
    if (!response.ok || text.includes('event: turn.failed')) throw new Error(`Agent turn failed: ${text.slice(-1000)}`);
  } finally { clearTimeout(timeout); }

  let runs = [];
  for (let attempt = 0; attempt < 120; attempt += 1) {
    runs = (await request(`/playbooks/${encodeURIComponent(playbook.id)}/runs`)).items;
    const current = runs[0];
    if (current && ['succeeded', 'failed', 'cancelled'].includes(current.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const run = runs[0];
  if (!run || run.status !== 'succeeded') throw new Error(`Agent-started Playbook did not succeed: ${JSON.stringify(run)}`);
  const artifacts = await request(`/runs/${encodeURIComponent(run.id)}/artifacts`);
  const preview = await request(`/runs/${encodeURIComponent(run.id)}/artifacts/preview?path=${encodeURIComponent('reports/agent-playbook.txt')}`);
  if (!artifacts.items.some(({ path }) => path === 'reports/agent-playbook.txt') || !preview.text.includes('AEGIS_AGENT_PLAYBOOK_OK')) throw new Error('Agent-started Playbook Artifact is missing or invalid');
  console.log(`Agent + Playbook MCP smoke passed: ${session.id} / ${playbook.id} / ${run.id}`);
} finally {
  if (session?.id) await request(`/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' }).catch(() => {});
  if (playbook?.id) await request(`/playbooks/${encodeURIComponent(playbook.id)}`, { method: 'DELETE' }).catch(() => {});
}
