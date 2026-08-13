import { expect, test } from './fixtures';
import { ROUTES } from '../src/constants';

test.describe.configure({ mode: 'serial' });
test.setTimeout(60_000);

test('opens the route-backed Playbook detail with the complete fixture DAG', async ({ gotoPage, page }) => {
  const resourceRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/plugins/') && request.url().includes('/resources/')) {
      resourceRequests.push(request.url());
    }
  });

  await gotoPage(`/${ROUTES.Playbooks}/pb-001`);

  await expect(page.locator('.playbook-breadcrumb code')).toHaveText('checkout-latency-investigation', {
    timeout: 15_000,
  });
  const dag = page.getByRole('img', { name: 'Playbook DAG' });
  await expect(dag).toBeVisible();
  await expect(dag.locator('[data-step-id]')).toHaveCount(6);
  await expect(dag.getByText('查基线 p95')).toBeVisible();
  await page.getByRole('tab', { name: 'YAML 源码' }).click();
  await expect(page.getByLabel('Playbook YAML')).toContainText('type: mcp_call');
  expect(resourceRequests).toEqual([]);
});

test('streams a Playbook dry-run through HITL', async ({ gotoPage, page }) => {
  await gotoPage(`/${ROUTES.Playbooks}/pb-001`);
  await expect(page.locator('.playbook-breadcrumb code')).toHaveText('checkout-latency-investigation', {
    timeout: 15_000,
  });
  await page.getByRole('button', { name: '跑（dry_run）' }).click();
  const setup = page.getByRole('dialog', { name: '运行 checkout-latency-investigation' });
  await setup.getByRole('button', { name: '开始 dry_run' }).click();

  const result = page.getByRole('region', { name: 'Playbook 执行结果' });
  await expect(result.getByText(/需要 HITL/)).toBeVisible({ timeout: 15_000 });
  await result.getByRole('button', { name: '批准模拟执行' }).click();
  await expect(result.locator('.playbook-run-status')).toHaveText('success', { timeout: 15_000 });
  await expect(result.getByText('dry_run approved · 未执行真实副作用')).toBeVisible();
});

test('creates a private Playbook and restores it after reload', async ({ gotoPage, page }) => {
  await gotoPage(`/${ROUTES.Playbooks}`);
  await expect(page.getByText('5 个 playbook')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: '新建 Playbook' }).click();
  await page.getByRole('textbox', { name: 'Playbook name' }).fill('e2e-private-playbook');
  await page.getByRole('textbox', { name: 'Playbook description' }).fill('E2E 创建的私有排查流程');
  await page.getByRole('button', { name: '保存' }).click();

  await expect(page.locator('.playbook-breadcrumb code')).toHaveText('e2e-private-playbook', { timeout: 15_000 });
  await page.reload();
  await expect(page.locator('.playbook-breadcrumb code')).toHaveText('e2e-private-playbook', { timeout: 15_000 });
});
