import { expect, test } from './fixtures';
import { ROUTES } from '../src/constants';

test('opens the complete fixture workbench without Resource API calls', async ({ gotoPage, page }) => {
  const resourceRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes(`/api/plugins/`) && request.url().includes('/resources/')) {
      resourceRequests.push(request.url());
    }
  });

  await gotoPage(`/${ROUTES.Workbench}`);

  await expect(page).toHaveURL(/\/workbench\/s-001$/);
  await expect(page.getByRole('complementary', { name: '会话历史' })).toBeVisible();
  await expect(page.getByRole('region', { name: '对话' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: '上下文' })).toContainText('active_folder_uid=infra');
  const canvas = page.getByTestId('session-canvas');
  await expect(canvas).toBeVisible();
  await expect(canvas.getByText('p95 latency (7d)', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '消息输入' })).toBeEnabled();
  expect(resourceRequests).toEqual([]);
});

test('creates a fixture session and restores it after reload', async ({ gotoPage, page }) => {
  await gotoPage(`/${ROUTES.Workbench}`);

  const sessionHistory = page.getByRole('complementary', { name: '会话历史' });
  await sessionHistory.getByRole('button', { name: '新建会话' }).click();
  await page.getByRole('textbox', { name: '会话标题' }).fill('支付链路新排查');
  await page.getByRole('button', { name: '创建', exact: true }).click();

  await expect(page).toHaveURL(/\/workbench\/session-/);
  await expect(page.getByText('这个会话还没有保存画布')).toBeVisible();

  await page.reload();

  await expect(sessionHistory.getByText('支付链路新排查')).toBeVisible();
  await expect(page.getByText('这个会话还没有保存画布')).toBeVisible();
});

test('streams a read tool call and saves its chart to Canvas', async ({ gotoPage, page }) => {
  await gotoPage(`/${ROUTES.Workbench}/s-001`);

  const composer = page.getByRole('textbox', { name: '消息输入' });
  await expect(composer).toBeEnabled();
  await composer.fill('@checkout-api p95 这周趋势');
  await composer.press('Enter');

  await expect(
    page.getByText('本周 p95 中位数为 320ms，较上周 280ms 上升 14%。建议继续检查下游 PG 连接池。')
  ).toBeVisible();
  await expect(
    page.locator('.tool-call-result').filter({ hasText: '本周 p95: 320ms 上周: 280ms diff: +14%' }).last()
  ).toBeVisible();
  await expect(page.getByTestId('session-canvas').getByText('checkout-api p95 latency (7d)')).toBeVisible();
  await expect(page.getByText('streaming')).toHaveCount(0);
});

test('requires rejection feedback when the active folder cannot approve writes', async ({ gotoPage, page }) => {
  await gotoPage(`/${ROUTES.Workbench}/s-001`);

  const composer = page.getByRole('textbox', { name: '消息输入' });
  await expect(composer).toBeEnabled();
  await composer.fill('创建一个 p99 panel');
  await composer.press('Enter');

  const approval = page.getByRole('dialog', { name: '写操作需审批' });
  await expect(approval.getByRole('button', { name: '批准执行' })).toBeDisabled();
  await approval.getByRole('button', { name: '拒绝' }).click();
  await expect(approval.getByRole('button', { name: '确认拒绝' })).toBeDisabled();
  await approval.getByRole('textbox', { name: '拒绝原因' }).fill('当前 Folder 仅有 View 权限');
  await approval.getByRole('button', { name: '确认拒绝' }).click();

  await expect(page.getByText(/操作已跳过/)).toBeVisible();
});
