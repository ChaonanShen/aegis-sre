#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const port = process.env.GRAFANA_PORT ?? '3000';
const passwordFile = process.env.GRAFANA_ADMIN_PASSWORD_FILE ?? 'deploy/local/secrets/grafana-admin-password';
const password = readFileSync(passwordFile, 'utf8').trim();
const folderUID = process.env.AEGIS_SMOKE_FOLDER_UID ?? 'infra';
const base = `http://127.0.0.1:${port}/api/plugins/grafana-plugin-app/resources/api/v1`;
const authorization = `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`;
const operationID = (kind) => `${kind}-${randomUUID()}`;

const source = `type: graph
description: Verify the Aegis product path to Dagu.

steps:
  - id: report
    action: template.render
    with:
      data:
        status: connected
      template: |
        AEGIS_PLAYBOOK_OK: {{ .status }}
    stdout:
      artifact: reports/product-smoke.txt
`;

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    // Playbook 是 Folder-owned；本地烟测必须通过同一条授权链传入目标 Folder。
    headers: { Authorization: authorization, 'X-Aegis-Folder-UID': folderUID, ...options.headers },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${path} returned HTTP ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : undefined;
}

const validation = await request('/playbooks/validate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/yaml' },
  body: source,
});
if (!validation.valid || validation.errors.length !== 0) {
  throw new Error(`native Dagu YAML validation failed: ${JSON.stringify(validation.errors)}`);
}

let playbook;
try {
  playbook = await request('/playbooks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/yaml', 'Idempotency-Key': operationID('playbook') },
    body: source,
  });

  const page = await request('/playbooks');
  if (!page.items.some(({ id }) => id === playbook.id)) {
    throw new Error('created Playbook is not visible through the scoped product list');
  }

  const run = await request(`/playbooks/${encodeURIComponent(playbook.id)}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': operationID('run') },
    body: JSON.stringify({ parameters: {} }),
  });

  let current = run;
  for (let attempt = 0; attempt < 60 && !['succeeded', 'failed', 'cancelled'].includes(current.status); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    current = await request(`/runs/${encodeURIComponent(run.id)}`);
  }
  if (current.status !== 'succeeded' || !current.steps.some(({ id, status }) => id === 'report' && status === 'succeeded')) {
    throw new Error(`Playbook Run did not succeed: ${JSON.stringify(current)}`);
  }

  const artifacts = await request(`/runs/${encodeURIComponent(run.id)}/artifacts`);
  const artifactPath = 'reports/product-smoke.txt';
  if (!artifacts.items.some(({ path }) => path === artifactPath)) {
    throw new Error(`Playbook artifact is missing: ${JSON.stringify(artifacts.items)}`);
  }
  const preview = await request(
    `/runs/${encodeURIComponent(run.id)}/artifacts/preview?path=${encodeURIComponent(artifactPath)}`
  );
  if (!preview.text.includes('AEGIS_PLAYBOOK_OK: connected')) {
    throw new Error('Playbook artifact did not contain the expected product-path output');
  }

  console.log(`Product Playbook smoke passed: ${playbook.id} / ${run.id}`);
} finally {
  if (playbook?.id) {
    await request(`/playbooks/${encodeURIComponent(playbook.id)}`, { method: 'DELETE' });
  }
}
