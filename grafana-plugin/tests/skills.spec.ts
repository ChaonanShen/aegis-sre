import { expect, test } from './fixtures';
import { ROUTES } from '../src/constants';

test.describe.configure({ mode: 'serial' });
test.setTimeout(60_000);

test('opens the Skills split workspace with source, preview, and MCP runtime', async ({ gotoPage, page }) => {
  const resourceRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/plugins/') && request.url().includes('/resources/')) {
      resourceRequests.push(request.url());
    }
  });

  await gotoPage(`/${ROUTES.Skills}/sk-001`);

  const list = page.getByRole('region', { name: 'Skill 列表' });
  await expect(list.getByText('checkout-troubleshoot', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByLabel('Skill source')).toContainText('slash-command: /check-cart');
  await expect(page.getByLabel('Skill source')).not.toContainText('visibility');
  await expect(page.getByText('running :8083/mcp')).toBeVisible();
  await expect(page.getByText('暴露的 9 个 tools')).toBeVisible();
  expect(resourceRequests).toEqual([]);
});

test('runs a read-only Skill and restores the recent result', async ({ gotoPage, page }) => {
  await gotoPage(`/${ROUTES.Skills}/sk-001`);
  await expect(page.getByText('/check-cart', { exact: true }).first()).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: '跑（dry_run）' }).click();
  const dialog = page.getByRole('dialog', { name: '运行 checkout-troubleshoot' });
  await dialog.getByRole('button', { name: '开始 dry_run' }).click();
  const result = dialog.getByRole('region', { name: 'Skill 执行结果' });
  await expect(result.locator('.skill-run-status')).toHaveText('success', { timeout: 15_000 });
  await expect(result.getByText(/checkout-troubleshoot dry_run 报告/)).toBeVisible();

  await dialog.getByRole('button', { name: '关闭运行' }).click();
  await page.getByRole('button', { name: '跑（dry_run）' }).click();
  await expect(page.getByRole('region', { name: 'Skill 执行结果' }).locator('.skill-run-status')).toHaveText(
    'success'
  );
});

test('creates and revises a private Skill', async ({ gotoPage, page }) => {
  await gotoPage(`/${ROUTES.Skills}`);
  await expect(page.getByRole('heading', { name: 'Skills', exact: true })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: '新建' }).click();
  await page.getByRole('textbox', { name: 'Skill name' }).fill('e2e-debug-skill');
  await page.getByRole('textbox', { name: 'Skill description' }).fill('E2E 创建的排查 Skill');
  await page.getByRole('textbox', { name: 'Slash Command' }).fill('/e2e-debug');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('/e2e-debug', { exact: true }).first()).toBeVisible();

  await page.getByRole('button', { name: '编辑' }).click();
  await page.getByRole('textbox', { name: 'Skill description' }).fill('E2E 更新后的排查 Skill');
  await page.getByRole('textbox', { name: 'Skill change note' }).fill('E2E 补充说明');
  await page.getByRole('button', { name: '保存' }).click();
  await page.getByRole('button', { name: 'History' }).click();
  await expect(page.getByRole('dialog', { name: 'Skill 历史' }).getByText('E2E 补充说明')).toBeVisible();
});
