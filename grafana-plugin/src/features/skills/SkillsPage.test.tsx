import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { createFixtureFolderGateway } from '../../app/adapters/fixtureFolderGateway';
import { fixtureFolders } from '../../app/fixtures/folderFixtures';
import { AppServicesProvider } from '../../app/AppServices';
import { AppShell } from '../../app/AppShell';
import { AppShellProvider } from '../../app/AppShellContext';
import { createFixtureSkillGateway } from './adapters/fixtureSkillGateway';
import SkillsPage from './SkillsPage';

let storageSequence = 0;

describe('SkillsPage', () => {
  test('renders the screenshot split view and filters cards', async () => {
    renderPage('/a/grafana-plugin-app/skills');
    expect((await screen.findAllByText('checkout-troubleshoot')).length).toBeGreaterThan(0);
    const list = screen.getByRole('region', { name: 'Skill 列表' });
    expect(screen.getByLabelText('Skill source')).toHaveTextContent('slash-command: /check-cart');
    expect(screen.queryByText(/Skills MCP Server/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: '搜索 Skill' }), { target: { value: 'personal' } });
    expect(within(list).getByText('my-personal-debug')).toBeInTheDocument();
    expect(within(list).queryByText('checkout-troubleshoot')).not.toBeInTheDocument();
  });

  test('opens route-backed selection and respects the resource Folder permission', async () => {
    renderPage('/a/grafana-plugin-app/skills/sk-002');
    expect((await screen.findAllByText('/p95-trace', { selector: 'code' })).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: '编辑' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '预览运行' })).toBeEnabled();
  });

  test('does not expose the editor through a direct route for a View-only Skill', async () => {
    renderPage('/a/grafana-plugin-app/skills/sk-002/edit');
    expect((await screen.findAllByText('/p95-trace', { selector: 'code' })).length).toBeGreaterThan(0);
    expect(screen.queryByRole('textbox', { name: 'Skill name' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '编辑' })).toBeDisabled();
  });

  test('creates a private skill from Go-compatible source metadata', async () => {
    renderPage('/a/grafana-plugin-app/skills');
    expect((await screen.findAllByText('/check-cart', { selector: 'code' })).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '新建' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Skill name' }), {
      target: { value: 'new-debug-skill' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Skill description' }), {
      target: { value: '新的排查 Skill' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Slash Command' }), {
      target: { value: '/new-debug' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect((await screen.findAllByText('/new-debug', { selector: 'code' })).length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Skill source')).not.toHaveTextContent('visibility');
  });

  test('edits a skill and displays the saved revision', async () => {
    renderPage('/a/grafana-plugin-app/skills/sk-001');
    expect((await screen.findAllByText('/check-cart', { selector: 'code' })).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    fireEvent.change(await screen.findByRole('textbox', { name: 'Skill description' }), {
      target: { value: '更新后的 Checkout Skill' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Skill change note' }), {
      target: { value: '补充使用说明' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect((await screen.findAllByText('更新后的 Checkout Skill')).length).toBeGreaterThan(0);
    const historyTrigger = screen.getByRole('button', { name: 'History' });
    historyTrigger.focus();
    fireEvent.click(historyTrigger);
    const dialog = screen.getByRole('dialog', { name: 'Skill 历史' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByText('补充使用说明')).toBeInTheDocument();
    expect(within(dialog).getByText('Revision 4')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Skill 历史' })).not.toBeInTheDocument();
    expect(historyTrigger).toHaveFocus();
  });

  test('closes a detail modal when switching to another Skill', async () => {
    renderPage('/a/grafana-plugin-app/skills/sk-001');
    expect((await screen.findAllByText('/check-cart', { selector: 'code' })).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    expect(screen.getByRole('dialog', { name: 'Skill 历史' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /rollback-checkout/ }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Skill 历史' })).not.toBeInTheDocument());
    expect(await screen.findByRole('button', { name: '预览运行' })).toBeInTheDocument();
  });

  test('runs a read-only skill and reopens the persisted result', async () => {
    renderPage('/a/grafana-plugin-app/skills/sk-001');
    expect((await screen.findAllByText('/check-cart', { selector: 'code' })).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '预览运行' }));
    const dialog = screen.getByRole('dialog', { name: '运行 checkout-troubleshoot' });
    fireEvent.click(await within(dialog).findByRole('button', { name: '开始预览' }));
    const result = await within(dialog).findByRole('region', { name: 'Skill 执行结果' });
    expect(await within(result).findByText('success', { selector: '.skill-run-status' })).toBeInTheDocument();
    expect(within(result).getByText(/checkout-troubleshoot 运行预览报告/)).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: '关闭运行' }));
    fireEvent.click(screen.getByRole('button', { name: '预览运行' }));
    expect(await screen.findByRole('region', { name: 'Skill 执行结果' })).toHaveTextContent('success');
  });

  test('pauses a write skill and exposes View-only HITL behavior', async () => {
    renderPage('/a/grafana-plugin-app/skills/sk-003', { payment: 'View' });
    expect((await screen.findAllByText('/rollback-cart', { selector: 'code' })).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '预览运行' }));
    const dialog = screen.getByRole('dialog', { name: '运行 rollback-checkout' });
    fireEvent.click(await within(dialog).findByRole('button', { name: '开始预览' }));

    expect(await within(dialog).findByText(/需要确认/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: '批准模拟执行' })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: '跳过写操作' }));
    expect(await within(dialog).findByText('success', { selector: '.skill-run-status' })).toBeInTheDocument();
  });

  test('allows cancelling while a Skill run is still streaming', async () => {
    renderPage('/a/grafana-plugin-app/skills/sk-001', undefined, { streamDelayMs: 1_000 });
    expect((await screen.findAllByText('/check-cart', { selector: 'code' })).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '预览运行' }));
    const dialog = screen.getByRole('dialog', { name: '运行 checkout-troubleshoot' });
    fireEvent.click(await within(dialog).findByRole('button', { name: '开始预览' }));

    const result = await within(dialog).findByRole('region', { name: 'Skill 执行结果' });
    const cancel = within(result).getByRole('button', { name: '取消' });
    expect(cancel).toBeEnabled();
    fireEvent.click(cancel);
    expect(await within(result).findByText('cancelled', { selector: '.skill-run-status' })).toBeInTheDocument();
  });
});

function renderPage(
  initialEntry: string,
  permissions?: Record<string, 'View' | 'Edit' | 'Admin'>,
  options: { streamDelayMs?: number } = {}
) {
  const storageKey = `torchbearing.fixture.skills.test.${storageSequence++}`;
  const folderGateway = permissions
    ? {
        listFolders: async () =>
          fixtureFolders.map((folder) => ({
            ...folder,
            permission: permissions[folder.uid] ?? folder.permission,
          })),
      }
    : createFixtureFolderGateway({ latencyMs: 0 });
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AppServicesProvider
        services={{
          folderGateway,
          skillGateway: createFixtureSkillGateway({
            latencyMs: 0,
            permissions,
            storageKey,
            streamDelayMs: options.streamDelayMs ?? 0,
          }),
        }}
      >
        <AppShellProvider>
          <AppShell>
            <Routes>
              <Route element={<SkillsPage />} path="/a/grafana-plugin-app/skills" />
              <Route element={<SkillsPage />} path="/a/grafana-plugin-app/skills/*" />
            </Routes>
          </AppShell>
        </AppShellProvider>
      </AppServicesProvider>
    </MemoryRouter>
  );
}
