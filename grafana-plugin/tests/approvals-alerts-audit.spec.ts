import { expect, test } from './fixtures';
import { ROUTES } from '../src/constants';

test.describe.configure({ mode: 'serial' });
test.setTimeout(60_000);

test('approves a private Playbook, exposes it in Playbooks, and appends Audit', async ({ gotoPage, page }) => {
  const resourceRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/plugins/') && request.url().includes('/resources/')) {
      resourceRequests.push(request.url());
    }
  });
  await gotoPage(`/${ROUTES.Approvals}`);
  const card = page.getByText('search-index-lag-review', { exact: true }).locator('xpath=ancestor::article[1]');
  await expect(card).toBeVisible({ timeout: 15_000 });
  page.once('dialog', (dialog) => dialog.accept());
  await card.getByRole('button', { name: '通过' }).click();
  await expect(card).not.toBeVisible();

  await gotoPage(`/${ROUTES.Playbooks}/pb-008`);
  await expect(page.locator('.playbook-breadcrumb code')).toHaveText('search-index-lag-review', { timeout: 15_000 });
  await expect(page.getByText('shared · search')).toBeVisible();

  await gotoPage(`/${ROUTES.Audit}`);
  await expect(page.getByText('playbook/pb-008 → shared (Search)')).toBeVisible({ timeout: 15_000 });
  const auditRow = page
    .getByText('playbook/pb-008 → shared (Search)')
    .locator('xpath=ancestor::tr[1]');
  await expect(auditRow.getByText('object_promote_approved')).toBeVisible();
  expect(resourceRequests).toEqual([]);
});

test('requires a rejection reason and displays the saved review', async ({ gotoPage, page }) => {
  await gotoPage(`/${ROUTES.Approvals}`);
  const card = page.getByText('search-index-lag-review', { exact: true }).locator('xpath=ancestor::article[1]');
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.getByRole('button', { name: '拒绝' }).click();
  const dialog = page.getByRole('dialog', { name: '拒绝 search-index-lag-review' });
  await expect(dialog.getByRole('button', { name: '确认拒绝' })).toBeDisabled();
  await dialog.getByLabel('拒绝原因').fill('E2E：请补充回滚和验证步骤');
  await dialog.getByRole('button', { name: '确认拒绝' }).click();
  await page.getByRole('button', { name: 'rejected' }).click();
  await expect(page.getByText(/E2E：请补充回滚和验证步骤/)).toBeVisible();
});

test('refreshes Alerts through analysis and opens the recommended Playbook', async ({ gotoPage, page }) => {
  await gotoPage(`/${ROUTES.Alerts}/al-001`);
  await expect(page.getByRole('heading', { name: 'CheckoutLatencyHigh' })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: '刷新' }).click();
  const recommendation = page.getByRole('button', {
    name: '推荐 Playbook：checkout-latency-investigation',
  });
  await expect(recommendation).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: '查看完整分析' }).click();
  await expect(page.getByRole('dialog', { name: 'CheckoutLatencyHigh 完整分析' })).toContainText('HITL');
  await page.getByRole('button', { name: '关闭完整分析' }).click();
  await recommendation.click();
  await expect(page.locator('.playbook-breadcrumb code')).toHaveText('checkout-latency-investigation', {
    timeout: 15_000,
  });
});

test('filters Audit and downloads the filtered CSV', async ({ gotoPage, page }) => {
  await gotoPage(`/${ROUTES.Audit}`);
  await expect(page.getByText('1,247')).toBeVisible({ timeout: 15_000 });
  await page.getByLabel('审计结果').selectOption('rejected');
  await expect(page.getByText(/^1 条/)).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`audit-${new Date().toISOString().slice(0, 10)}.csv`);
});
