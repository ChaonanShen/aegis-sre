import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppServicesProvider, RuntimeMode } from '../../app/AppServices';
import { AppShell } from '../../app/AppShell';
import { AppShellProvider } from '../../app/AppShellContext';
import { createFixtureFolderGateway } from '../../app/adapters/fixtureFolderGateway';
import { createFixtureWorkbenchGateway } from './adapters/fixtureWorkbenchGateway';
import { OpenedSession } from './model';
import { WorkbenchGateway } from './ports/WorkbenchGateway';
import WorkbenchPage from './WorkbenchPage';

jest.setTimeout(15_000);

describe('WorkbenchPage', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
  });

  test('renders the complete seeded workbench', async () => {
    renderPage('/a/grafana-plugin-app/workbench/s-001');

    expect(await screen.findByRole('complementary', { name: '会话历史' })).toBeInTheDocument();
    expect(await screen.findByRole('textbox', { name: '消息输入' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '添加附件' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '对话' })).toBeInTheDocument();
    expect(await screen.findByText('p95 latency (7d)')).toBeInTheDocument();
    expect(screen.getByRole('log', { name: '交流时间线' })).toBeInTheDocument();
    expect(screen.getByRole('separator', { name: '调整会话历史宽度' })).toBeInTheDocument();
    expect(screen.getByRole('separator', { name: '调整对话宽度' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '打开上下文' }));
    const context = screen.getByRole('complementary', { name: '上下文' });
    expect(within(context).getByText('本会话可访问的证据范围')).toBeInTheDocument();
    expect(within(context).getByText('infra', { selector: 'code' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('complementary', { name: '上下文' })).not.toBeInTheDocument();

    const history = screen.getByRole('complementary', { name: '会话历史' });
    fireEvent.click(within(history).getByRole('button', { name: '收起会话历史' }));
    expect(screen.queryByRole('complementary', { name: '会话历史' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '展开会话历史' }));
    expect(screen.getByRole('complementary', { name: '会话历史' })).toBeInTheDocument();
  });

  test('restores and persists the workbench pane widths', async () => {
    window.localStorage.setItem(
      'torchbearing.workbench.split-layout.v1',
      JSON.stringify({ historyWidth: 300, conversationWidth: 460 })
    );
    renderPage('/a/grafana-plugin-app/workbench/s-001');

    const shell = screen.getByTestId('workbench-page').querySelector<HTMLElement>('.workbench-shell');
    expect(shell).toHaveStyle({ '--history-pane-width': '300px', '--conversation-pane-width': '460px' });

    fireEvent.keyDown(screen.getByRole('separator', { name: '调整会话历史宽度' }), { key: 'ArrowRight' });
    await waitFor(() =>
      expect(JSON.parse(window.localStorage.getItem('torchbearing.workbench.split-layout.v1') ?? '{}')).toEqual({
        historyWidth: 308,
        conversationWidth: 460,
      })
    );
  });

  test('only exposes the attachment entry in fixture mode', async () => {
    renderPage('/a/grafana-plugin-app/workbench/s-001', 'real');

    await screen.findByRole('textbox', { name: '消息输入' });
    expect(screen.queryByRole('button', { name: '添加附件' })).not.toBeInTheDocument();
  });

  test('offers session creation when the history is empty', async () => {
    const base = createFixtureWorkbenchGateway({ latencyMs: 0, streamDelayMs: 0 });
    const gateway: WorkbenchGateway = { ...base, listSessions: async () => [] };

    renderPage('/a/grafana-plugin-app/workbench', 'fixture', gateway);

    expect((await screen.findAllByText('还没有会话')).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByRole('button', { name: '新建会话' }).length).toBeGreaterThan(0);
  });

  test('does not retain a fullscreen chart when switching Sessions', async () => {
    renderPage('/a/grafana-plugin-app/workbench/s-001');

    await screen.findByRole('textbox', { name: '消息输入' });
    fireEvent.click(screen.getByRole('button', { name: /全屏 p95 latency/ }));
    expect(screen.getByRole('dialog', { name: /p95 latency/ })).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('session-item-s-002'));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /p95 latency/ })).not.toBeInTheDocument());
  });

  test('creates a session and shows the quick actions', async () => {
    renderPage('/a/grafana-plugin-app/workbench/s-001');

    const history = await screen.findByRole('complementary', { name: '会话历史' });
    fireEvent.click(within(history).getByRole('button', { name: '新建会话' }));
    expect(await screen.findByText('会话将使用当前 Folder：Infra')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: '会话标题' }), { target: { value: '支付链路新排查' } });
    fireEvent.click(screen.getByRole('button', { name: /^创建$/ }));

    expect(await screen.findAllByText('支付链路新排查')).toHaveLength(2);
    expect(await screen.findByRole('button', { name: /@checkout-api p95 这周趋势/ })).toBeInTheDocument();
  });

  test('does not claim that a real session binds the selected Folder', async () => {
    renderPage('/a/grafana-plugin-app/workbench/s-001', 'real');

    await screen.findByRole('textbox', { name: '消息输入' });
    const history = screen.getByRole('complementary', { name: '会话历史' });
    fireEvent.click(within(history).getByRole('button', { name: '新建会话' }));

    expect(screen.getByText('会话创建后暂不绑定 Folder。')).toBeInTheDocument();
    expect(screen.queryByText(/会话将使用当前 Folder/)).not.toBeInTheDocument();
  });

  test('focuses and closes the create dialog with Escape', async () => {
    renderPage('/a/grafana-plugin-app/workbench/s-001');

    const history = await screen.findByRole('complementary', { name: '会话历史' });
    const opener = within(history).getByRole('button', { name: '新建会话' });
    opener.focus();
    fireEvent.click(opener);

    const dialog = await screen.findByRole('dialog', { name: '新建会话' });
    expect(within(dialog).getByRole('textbox', { name: '会话标题' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '新建会话' })).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  test('keeps the create dialog open while creation is in flight', async () => {
    const base = createFixtureWorkbenchGateway({ latencyMs: 0, streamDelayMs: 0, storageKey: 'workbench-create-a11y' });
    let releaseCreate: () => void = () => undefined;
    const gateway: WorkbenchGateway = {
      ...base,
      createSession: jest.fn(
        (input) =>
          new Promise<OpenedSession>((resolve) => {
            releaseCreate = () => {
              void base.createSession(input).then(resolve);
            };
          })
      ),
    };
    renderPage('/a/grafana-plugin-app/workbench/s-001', 'fixture', gateway);

    const history = await screen.findByRole('complementary', { name: '会话历史' });
    fireEvent.click(within(history).getByRole('button', { name: '新建会话' }));
    const dialog = await screen.findByRole('dialog', { name: '新建会话' });
    fireEvent.change(within(dialog).getByRole('textbox', { name: '会话标题' }), {
      target: { value: '延迟创建' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '创建' }));

    await waitFor(() => expect(within(dialog).getByRole('button', { name: '创建中…' })).toBeDisabled());
    expect(within(dialog).getByRole('button', { name: '关闭新建会话' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: '取消' })).toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog', { name: '新建会话' })).toBeInTheDocument();

    releaseCreate();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '新建会话' })).not.toBeInTheDocument());
  });

  test('deletes the current session after confirmation and opens the adjacent session', async () => {
    renderPage('/a/grafana-plugin-app/workbench/s-001');
    await screen.findByRole('textbox', { name: '消息输入' });

    fireEvent.click(screen.getByRole('button', { name: '会话更多操作' }));
    fireEvent.click(screen.getByRole('button', { name: '删除会话' }));

    const modal = screen.getByRole('dialog', { name: '删除会话' });
    expect(within(modal).getByText('Checkout 服务 p95 延迟排查')).toBeInTheDocument();
    expect(within(modal).getByText('会话中的消息、查询、图表和画布内容将一起删除。')).toBeInTheDocument();
    fireEvent.click(within(modal).getByRole('button', { name: '删除会话' }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: '删除会话' })).not.toBeInTheDocument());
    expect(await screen.findAllByText('上周三告警复盘')).not.toHaveLength(0);
    const history = screen.getByRole('complementary', { name: '会话历史' });
    expect(within(history).queryByText('Checkout 服务 p95 延迟排查')).not.toBeInTheDocument();
  });

  test('streams a fixture tool call and assistant response', async () => {
    renderPage('/a/grafana-plugin-app/workbench/s-001');
    const input = await screen.findByRole('textbox', { name: '消息输入' });
    await screen.findByText('Folder: Infra');

    fireEvent.change(input, { target: { value: '@checkout-api p95 这周趋势' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await screen.findByText(/本周 p95 中位数为 320ms/);
    expect(screen.getAllByText(/本周 p95: 320ms/)).toHaveLength(2);
    await waitFor(() => expect(screen.queryByText('生成中')).not.toBeInTheDocument());
  });

  test('requires HITL and blocks approval for a View folder', async () => {
    renderPage('/a/grafana-plugin-app/workbench/s-001');
    const input = await screen.findByRole('textbox', { name: '消息输入' });
    await screen.findByText('Folder: Infra');

    fireEvent.change(input, { target: { value: '创建一个 p99 panel' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    const modal = await screen.findByRole('dialog', { name: '写操作需审批' });
    expect(within(modal).getByText('是否执行及留痕以服务端返回结果为准')).toBeInTheDocument();
    expect(within(modal).queryByText('审批结果会记录到审计日志')).not.toBeInTheDocument();
    expect(within(modal).getByRole('button', { name: '批准执行' })).toBeDisabled();
    fireEvent.click(within(modal).getByRole('button', { name: '拒绝' }));
    expect(within(modal).getByRole('button', { name: '确认拒绝' })).toBeDisabled();
    fireEvent.change(within(modal).getByRole('textbox', { name: '拒绝原因' }), {
      target: { value: '暂不执行' },
    });
    fireEvent.click(within(modal).getByRole('button', { name: '确认拒绝' }));

    await screen.findByText(/操作已跳过/);
  });
});

function renderPage(
  initialEntry: string,
  runtimeMode: RuntimeMode = 'fixture',
  workbenchGateway: WorkbenchGateway = createFixtureWorkbenchGateway({ latencyMs: 0, streamDelayMs: 0 })
) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AppServicesProvider
        runtimeMode={runtimeMode}
        services={{
          folderGateway: createFixtureFolderGateway({ latencyMs: 0 }),
          workbenchGateway,
        }}
      >
        <AppShellProvider>
          <AppShell>
            <Routes>
              <Route element={<WorkbenchPage />} path="/a/grafana-plugin-app/workbench/:sessionId?" />
            </Routes>
          </AppShell>
        </AppShellProvider>
      </AppServicesProvider>
    </MemoryRouter>
  );
}
