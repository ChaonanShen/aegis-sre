import { expect, test } from './fixtures';
import { ROUTES } from '../src/constants';

test('keeps Infra read-only and strictly filters resources after switching Folder', async ({ gotoPage, page }) => {
  const resourceRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/plugins/') && request.url().includes('/resources/')) {
      resourceRequests.push(request.url());
    }
  });

  await gotoPage(`/${ROUTES.Knowledge}`);

  await expect(page.getByRole('heading', { name: 'Service Entry · Infra' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: '新建 Service', exact: true })).toBeDisabled();
  await expect(page.getByText('@postgres', { exact: true })).toBeVisible();

  const navigation = page.getByRole('complementary', { name: 'Knowledge 导航' });
  await navigation.getByRole('button', { name: /Payment/ }).click();

  await expect(page.getByRole('heading', { name: 'Service Entry · Payment' })).toBeVisible();
  await expect(page.getByRole('button', { name: '新建 Service', exact: true })).toBeEnabled();
  await expect(page.getByText('@checkout-api', { exact: true })).toBeVisible();
  await expect(page.getByText('@postgres', { exact: true })).toHaveCount(0);
  expect(resourceRequests).toEqual([]);
});

test('creates a Service and restores it after reload', async ({ gotoPage, page }) => {
  await gotoPage(`/${ROUTES.Knowledge}`);
  const navigation = page.getByRole('complementary', { name: 'Knowledge 导航' });
  await navigation.getByRole('button', { name: /Payment/ }).click();
  await expect(page.getByRole('heading', { name: 'Service Entry · Payment' })).toBeVisible();

  await page.getByRole('button', { name: '新建 Service', exact: true }).click();
  const form = page.getByRole('dialog', { name: '新建 Service' });
  await form.getByRole('textbox', { name: 'Service name' }).fill('fraud-api');
  await form.getByRole('textbox', { name: 'Display name' }).fill('Fraud API');
  await form.getByRole('textbox', { name: 'Owner' }).fill('risk-team');
  await form.getByRole('button', { name: '保存' }).click();

  await expect(page.getByText('@fraud-api', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Service Entry · Payment' })).toBeVisible();
  await expect(page.getByText('@fraud-api', { exact: true })).toBeVisible();
});

test('keeps a Runbook version after editing', async ({ gotoPage, page }) => {
  await gotoPage(`/${ROUTES.Knowledge}`);
  const navigation = page.getByRole('complementary', { name: 'Knowledge 导航' });
  await navigation.getByRole('button', { name: /Payment/ }).click();
  await expect(page.getByRole('heading', { name: 'Service Entry · Payment' })).toBeVisible();
  await navigation.getByRole('button', { name: /Runbook/ }).click();

  await page.getByRole('button', { name: /编辑/ }).click();
  const form = page.getByRole('dialog', { name: '编辑 Runbook' });
  await form.getByRole('textbox', { name: 'Runbook 标题' }).fill('Checkout p95 排查 v2');
  await form.getByRole('textbox', { name: 'Runbook 正文' }).fill('# Checkout p95 排查 v2\n\n新增连接池检查。');
  await form.getByRole('button', { name: '保存' }).click();

  await expect(page.getByRole('heading', { name: 'Checkout p95 排查 v2' })).toBeVisible();
  await page.getByRole('button', { name: /History/ }).click();
  const history = page.getByRole('dialog', { name: /版本历史/ });
  await expect(history.getByText('v1 · Checkout 服务 p95 延迟升高排查')).toBeVisible();
});

test('imports a document through parsing and review', async ({ gotoPage, page }) => {
  await gotoPage(`/${ROUTES.Knowledge}`);
  const navigation = page.getByRole('complementary', { name: 'Knowledge 导航' });
  await navigation.getByRole('button', { name: /Payment/ }).click();
  await expect(page.getByRole('heading', { name: 'Service Entry · Payment' })).toBeVisible();
  await navigation.getByRole('button', { name: /Document/ }).click();

  await page.getByTestId('knowledge-file-input').setInputFiles({
    name: 'new-checkout-guide.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from('# Checkout guide\n\nCheck PG first.'),
  });

  await expect(page.getByRole('heading', { name: 'Import Tasks · Payment' })).toBeVisible();
  const newestTask = page.getByRole('region', { name: 'Import Task 列表' }).locator('article').first();
  await newestTask.getByRole('button', { name: '查看 → 确认' }).click();
  const review = page.getByRole('dialog', { name: /确认导入任务/ });
  await expect(review.getByText('new-checkout-guide.md')).toBeVisible();
  await review.getByRole('button', { name: '确认入库' }).click();

  const result = page.getByRole('dialog', { name: /导入任务 .* 结果/ });
  await expect(result.getByText('已生成 1 个 Document')).toBeVisible();
  await result.getByRole('button', { name: '关闭导入结果' }).click();
  await navigation.getByRole('button', { name: /Document/ }).click();
  await expect(page.getByText('new-checkout-guide.md', { exact: true })).toBeVisible();
});
