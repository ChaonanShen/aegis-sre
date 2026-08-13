import { expect, test } from './fixtures';
import { ROUTES } from '../src/constants';

test.setTimeout(60_000);

test('creates, reloads, updates, and deletes a native Dagu Playbook', async ({ gotoPage, page }) => {
  const resourceRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/plugins/') && request.url().includes('/resources/api/v1/playbooks')) {
      resourceRequests.push(request.url());
    }
  });

  await gotoPage(`/${ROUTES.Playbooks}`);
  await expect(page.getByRole('heading', { name: 'Playbooks', exact: true })).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: '新建 Playbook' }).click();

  const sourceV1 = `name: e2e-native-crud
description: E2E native CRUD v1
steps:
  - id: inspect
    run: echo ok
`;
  await page.getByRole('textbox', { name: 'Playbook YAML 编辑器' }).fill(sourceV1);
  await page.getByRole('button', { name: '保存' }).click();

  await expect(page.locator('.playbook-breadcrumb code')).toHaveText('e2e-native-crud', { timeout: 15_000 });
  await page.reload();
  await expect(page.locator('.playbook-breadcrumb code')).toHaveText('e2e-native-crud', { timeout: 15_000 });

  await page.getByRole('button', { name: '编辑' }).click();
  const sourceV2 = sourceV1.replace('E2E native CRUD v1', 'E2E native CRUD v2').replace('echo ok', 'echo updated');
  await page.getByRole('textbox', { name: 'Playbook YAML 编辑器' }).fill(sourceV2);
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('E2E native CRUD v2')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('tab', { name: 'YAML 源码' }).click();
  await expect(page.getByLabel('Playbook YAML')).toContainText('echo updated');

  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '删除' }).click();
  await expect(page.getByRole('heading', { name: 'Playbooks', exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('e2e-native-crud', { exact: true })).toHaveCount(0);
  expect(resourceRequests.length).toBeGreaterThanOrEqual(7);
});
