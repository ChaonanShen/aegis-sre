import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AppServicesProvider } from '../../app/AppServices';
import { AppShell } from '../../app/AppShell';
import { AppShellProvider } from '../../app/AppShellContext';
import { createFixtureFolderGateway } from '../../app/adapters/fixtureFolderGateway';
import { createFixtureKnowledgeGateway } from './adapters/fixtureKnowledgeGateway';
import KnowledgePage from './KnowledgePage';

let storageSequence = 0;
let knowledgeStorageKey = '';

describe('KnowledgePage services', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    knowledgeStorageKey = `torchbearing.fixture.knowledge.test.${storageSequence++}`;
  });

  test('keeps Infra as the global default and enforces its View permission', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { name: '服务 · Infra' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新建服务' })).toBeDisabled();
    expect(screen.getByText('@postgres')).toBeInTheDocument();
    expect(screen.queryByText('@checkout-api')).not.toBeInTheDocument();
  });

  test('strictly switches data with the selected Folder', async () => {
    renderPage();
    const navigation = await screen.findByRole('complementary', { name: '知识库导航' });

    fireEvent.click(await within(navigation).findByRole('button', { name: /Payment/ }));

    expect(await screen.findByRole('heading', { name: '服务 · Payment' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '新建服务' })).toBeEnabled();
    expect(await screen.findByText('@checkout-api')).toBeInTheDocument();
    expect(screen.queryByText('@postgres')).not.toBeInTheDocument();
  });

  test('closes resource dialogs when switching Folder scope', async () => {
    renderPage();
    const navigation = await screen.findByRole('complementary', { name: '知识库导航' });
    fireEvent.click(await within(navigation).findByRole('button', { name: /Payment/ }));
    await screen.findByRole('heading', { name: '服务 · Payment' });

    fireEvent.click(screen.getByRole('button', { name: '新建服务' }));
    expect(screen.getByRole('dialog', { name: '新建 Service' })).toBeInTheDocument();

    fireEvent.click(within(navigation).getByRole('button', { name: /Infra/ }));
    await screen.findByRole('heading', { name: '服务 · Infra' });
    expect(screen.queryByRole('dialog', { name: '新建 Service' })).not.toBeInTheDocument();
  });

  test('cleans resource state when the global topbar switches Folder', async () => {
    renderPage('/a/grafana-plugin-app/knowledge?query=checkout', { topbar: true });
    const navigation = await screen.findByRole('complementary', { name: '知识库导航' });
    fireEvent.click(await within(navigation).findByRole('button', { name: /Payment/ }));
    await screen.findByRole('heading', { name: '服务 · Payment' });
    fireEvent.click(screen.getByRole('button', { name: '新建服务' }));
    expect(screen.getByRole('dialog', { name: '新建 Service' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Folder: Payment/ }));
    const folderDialog = screen.getByRole('dialog', { name: '选择 Folder' });
    fireEvent.click(within(folderDialog).getByRole('button', { name: /Infra/ }));

    expect(await screen.findByRole('heading', { name: '服务 · Infra' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: '新建 Service' })).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '搜索服务' })).toHaveValue('');
  });

  test('creates and persists a Service through the Fixture gateway', async () => {
    renderPage();
    const navigation = await screen.findByRole('complementary', { name: '知识库导航' });
    fireEvent.click(await within(navigation).findByRole('button', { name: /Payment/ }));
    await screen.findByRole('heading', { name: '服务 · Payment' });

    fireEvent.click(screen.getByRole('button', { name: '新建服务' }));
    const dialog = screen.getByRole('dialog', { name: '新建 Service' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Service name' }), {
      target: { value: 'fraud-api' },
    });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Display name' }), {
      target: { value: 'Fraud API' },
    });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Owner' }), {
      target: { value: 'risk-team' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));

    await screen.findByText('@fraud-api');
    await waitFor(() =>
      expect(JSON.parse(window.sessionStorage.getItem(knowledgeStorageKey) ?? '{}').services).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'fraud-api' })])
      )
    );
  });

  test('filters the service list without changing Folder data', async () => {
    renderPage();
    const navigation = await screen.findByRole('complementary', { name: '知识库导航' });
    fireEvent.click(await within(navigation).findByRole('button', { name: /Payment/ }));
    await screen.findByText('@checkout-api');

    fireEvent.change(screen.getByRole('textbox', { name: '搜索服务' }), { target: { value: 'order' } });

    expect(screen.getByText('@order-service')).toBeInTheDocument();
    expect(screen.queryByText('@checkout-api')).not.toBeInTheDocument();
  });

  test('restores and updates the Runbook tab and query through the URL', async () => {
    const view = renderPage('/a/grafana-plugin-app/knowledge?tab=runbooks&query=PG');

    expect(await screen.findByRole('heading', { name: 'Runbook · Infra' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '搜索 Runbook' })).toHaveValue('PG');

    fireEvent.change(screen.getByRole('textbox', { name: '搜索 Runbook' }), {
      target: { value: 'connection' },
    });
    await waitFor(() => expect(view.routerLocation()).toContain('?tab=runbooks&query=connection'));

    const navigation = screen.getByRole('complementary', { name: '知识库导航' });
    fireEvent.click(within(navigation).getByRole('button', { name: /文档/ }));
    await waitFor(() => expect(view.routerLocation()).toBe('/a/grafana-plugin-app/knowledge?tab=documents'));
    expect(await screen.findByRole('heading', { name: '文档 · Infra' })).toBeInTheDocument();
  });

  test('edits a Runbook and exposes the previous version in History', async () => {
    renderPage();
    const navigation = await screen.findByRole('complementary', { name: '知识库导航' });
    fireEvent.click(await within(navigation).findByRole('button', { name: /Payment/ }));
    await screen.findByRole('heading', { name: '服务 · Payment' });
    fireEvent.click(within(navigation).getByRole('button', { name: /Runbook/ }));

    expect(await screen.findByRole('heading', { name: 'Runbook · Payment' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /编辑/ }));
    const form = screen.getByRole('dialog', { name: '编辑 Runbook' });
    fireEvent.change(within(form).getByRole('textbox', { name: 'Runbook 标题' }), {
      target: { value: 'Checkout p95 排查 v2' },
    });
    fireEvent.change(within(form).getByRole('textbox', { name: 'Runbook 正文' }), {
      target: { value: '# Checkout p95 排查 v2\n\n新增连接池检查。' },
    });
    fireEvent.click(within(form).getByRole('button', { name: '保存' }));

    expect(await screen.findByRole('heading', { name: 'Checkout p95 排查 v2' })).toBeInTheDocument();
    const historyTrigger = screen.getByRole('button', { name: /History/ });
    historyTrigger.focus();
    fireEvent.click(historyTrigger);
    const history = screen.getByRole('dialog', { name: /版本历史/ });
    expect(history).toHaveAttribute('aria-modal', 'true');
    expect(within(history).getByText(/v1/)).toBeInTheDocument();
    expect(within(history).getByText('v1 · Checkout 服务 p95 延迟升高排查')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: /版本历史/ })).not.toBeInTheDocument();
    expect(historyTrigger).toHaveFocus();
  });

  test('imports a text document through reviewing and persists the result', async () => {
    renderPage();
    const navigation = await screen.findByRole('complementary', { name: '知识库导航' });
    fireEvent.click(await within(navigation).findByRole('button', { name: /Payment/ }));
    await screen.findByRole('heading', { name: '服务 · Payment' });
    fireEvent.click(within(navigation).getByRole('button', { name: /文档/ }));
    await screen.findByRole('heading', { name: '文档 · Payment' });

    const file = new File(['# Checkout guide\n\nCheck PG first.'], 'new-checkout-guide.md', {
      type: 'text/markdown',
    });
    fireEvent.change(screen.getByTestId('knowledge-file-input'), { target: { files: [file] } });

    expect(await screen.findByRole('heading', { name: '导入任务 · Payment' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole('button', { name: '查看 → 确认' }).length).toBeGreaterThan(1));
    fireEvent.click(screen.getAllByRole('button', { name: '查看 → 确认' })[0]);
    const review = screen.getByRole('dialog', { name: /确认导入任务/ });
    expect(within(review).getByText('new-checkout-guide.md')).toBeInTheDocument();
    fireEvent.click(within(review).getByRole('button', { name: '确认入库' }));

    const result = await screen.findByRole('dialog', { name: /导入任务 .* 结果/ });
    expect(within(result).getByText('已生成 1 个文档')).toBeInTheDocument();
    fireEvent.click(within(result).getByRole('button', { name: '关闭导入结果' }));
    fireEvent.click(within(navigation).getByRole('button', { name: /文档/ }));

    expect(await screen.findByText('new-checkout-guide.md')).toBeInTheDocument();
  });
});

function renderPage(initial = '/a/grafana-plugin-app/knowledge', options: { topbar?: boolean } = {}) {
  let path = initial;
  const result = render(
    <MemoryRouter initialEntries={[initial]}>
      <AppServicesProvider
        runtimeMode={options.topbar ? 'fixture' : 'real'}
        services={{
          folderGateway: createFixtureFolderGateway({ latencyMs: 0 }),
          knowledgeGateway: createFixtureKnowledgeGateway({
            latencyMs: 0,
            importDelayMs: 0,
            storageKey: knowledgeStorageKey,
          }),
        }}
      >
        <AppShellProvider>
          <AppShell>
            <Routes>
              <Route element={<KnowledgePage />} path="/a/grafana-plugin-app/knowledge" />
            </Routes>
            <LocationProbe onChange={(value) => (path = value)} />
          </AppShell>
        </AppShellProvider>
      </AppServicesProvider>
    </MemoryRouter>
  );
  return { ...result, routerLocation: () => path };
}

function LocationProbe({ onChange }: { onChange: (value: string) => void }) {
  const location = useLocation();
  onChange(`${location.pathname}${location.search}`);
  return null;
}
