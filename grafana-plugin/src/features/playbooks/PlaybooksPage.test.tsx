import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppServicesProvider } from '../../app/AppServices';
import { AppShell } from '../../app/AppShell';
import { AppShellProvider } from '../../app/AppShellContext';
import { createFixtureFolderGateway } from '../../app/adapters/fixtureFolderGateway';
import { createFixtureWorkbenchGateway } from '../workbench/adapters/fixtureWorkbenchGateway';
import { createFixturePlaybookGateway } from './adapters/fixturePlaybookGateway';
import { playbookFixtureData } from './fixtures/playbookFixtures';
import { PlaybookDraft } from './model';
import { PlaybookGateway } from './ports/PlaybookGateway';
import { PlaybookEditor } from './components/PlaybookEditor';
import PlaybooksPage from './PlaybooksPage';

let storageSequence = 0;

describe('PlaybooksPage', () => {
  test('aggregates accessible resources and filters by Folder and visibility', async () => {
    renderPage('/a/grafana-plugin-app/playbooks');

    expect(await screen.findByText('5 个 playbook')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Playbooks' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Playbook 列表' })).toHaveTextContent('checkout-latency-investigation');
    expect(screen.getByRole('region', { name: 'Playbook 列表' })).toHaveTextContent('pg-connection-pool-debug');

    fireEvent.change(screen.getByRole('combobox', { name: 'Folder 筛选' }), { target: { value: 'payment' } });
    expect(screen.getByRole('region', { name: 'Playbook 列表' })).toHaveTextContent('order-shipping-delay');
    expect(screen.queryByText('pg-connection-pool-debug')).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox', { name: 'Visibility 筛选' }), {
      target: { value: 'private' },
    });
    expect(screen.getByText('没有符合当前筛选条件的 Playbook。')).toBeInTheDocument();
  });

  test('opens a route-backed detail with DAG and YAML views', async () => {
    renderPage('/a/grafana-plugin-app/playbooks/pb-001');

    expect(await screen.findByText('checkout-latency-investigation', { selector: 'code' })).toBeInTheDocument();
    const dag = screen.getByRole('img', { name: 'Playbook DAG' });
    expect(within(dag).getByText('查基线 p95')).toBeInTheDocument();
    expect(dag.querySelectorAll('[data-step-id]')).toHaveLength(6);

    fireEvent.click(screen.getByRole('tab', { name: 'YAML 源码' }));
    expect(screen.getByLabelText('Playbook YAML')).toHaveTextContent('pattern: "CheckoutLatencyHigh"');
    expect(screen.getByLabelText('Playbook YAML')).toHaveTextContent('type: mcp_call');
  });

  test('syncs Step config text after applying a YAML edit', async () => {
    renderPage('/a/grafana-plugin-app/playbooks/pb-001/edit');

    const yaml = (await screen.findByRole('textbox', { name: 'Playbook YAML 编辑器' })) as HTMLTextAreaElement;
    fireEvent.change(yaml, { target: { value: yaml.value.replace(/expr:.*\n/, 'expr: up_new\n') } });
    fireEvent.click(screen.getByRole('button', { name: '应用 YAML' }));

    const config = (await screen.findByRole('textbox', { name: 'Step 1 config' })) as HTMLTextAreaElement;
    expect(config.value).toContain('up_new');
  });

  test('keeps an uncommitted Step config draft when the Step id changes', async () => {
    renderPage('/a/grafana-plugin-app/playbooks/pb-001/edit');

    const config = (await screen.findByRole('textbox', { name: 'Step 1 config' })) as HTMLTextAreaElement;
    const draftConfig = `${config.value}\n`;
    fireEvent.change(config, { target: { value: draftConfig } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Step 1 ID' }), { target: { value: 'baseline_p95_v2' } });

    expect(screen.getByRole('textbox', { name: 'Step 1 config' })).toHaveValue(draftConfig);
  });

  test('remounts editor state when the edited Playbook changes', () => {
    const [first, second] = playbookFixtureData.playbooks;
    const gateway = createFixturePlaybookGateway({ latencyMs: 0 });
    const editor = (playbook: typeof first) => (
      <MemoryRouter>
        <PlaybookEditor
          folders={[]}
          gateway={gateway}
          key={`edit:${playbook.id}`}
          onSaved={async () => undefined}
          playbook={playbook}
        />
      </MemoryRouter>
    );
    const { rerender } = render(editor(first));

    fireEvent.change(screen.getByRole('textbox', { name: 'Playbook name' }), { target: { value: 'dirty-a' } });
    rerender(editor(second));

    expect(screen.getByRole('textbox', { name: 'Playbook name' })).toHaveValue(second.name);
  });

  test('blocks save when an uncommitted Step config draft is invalid', async () => {
    const playbook = playbookFixtureData.playbooks[0];
    const baseGateway = createFixturePlaybookGateway({ latencyMs: 0 });
    const updatePlaybook = jest.fn(baseGateway.updatePlaybook);
    const gateway: PlaybookGateway = { ...baseGateway, updatePlaybook };
    render(
      <MemoryRouter>
        <PlaybookEditor folders={[]} gateway={gateway} onSaved={async () => undefined} playbook={playbook} />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByRole('textbox', { name: 'Step 1 config' }), { target: { value: '{invalid' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Step 1 Config JSON 无效');
    expect(updatePlaybook).not.toHaveBeenCalled();
  });

  test('starts a real-mode playbook with native Dagu YAML', async () => {
	const baseGateway = createFixturePlaybookGateway({ latencyMs: 0 });
	const createPlaybook = jest.fn(async (input: Parameters<PlaybookGateway['createPlaybook']>[0]) => ({
	  ...input,
	  id: 'pbk_abcdefgh', ownerId: 'user', usageCount: 0, recordVersion: 1,
	  latestChangeNote: input.changeNote, revisions: [], createdAt: '', updatedAt: '',
	}));
	const gateway: PlaybookGateway = { ...baseGateway, createPlaybook };
	render(
	  <MemoryRouter>
		<PlaybookEditor folders={[]} gateway={gateway} nativeMode onSaved={async () => undefined} />
	  </MemoryRouter>
	);

	const yaml = screen.getByRole('textbox', { name: 'Playbook YAML 编辑器' });
	expect(yaml).toHaveValue('description: 新建 Aegis Playbook\nsteps: []\n');
	fireEvent.change(yaml, { target: { value: 'description: Diagnose\nsteps:\n  - id: inspect\n    run: echo ok\n' } });
	fireEvent.click(screen.getByRole('button', { name: '应用 YAML' }));
	fireEvent.click(screen.getByRole('button', { name: '保存' }));

	expect(await screen.findByRole('button', { name: '已保存' })).toBeDisabled();
	expect(createPlaybook).toHaveBeenCalledWith(expect.objectContaining({
	  source: 'description: Diagnose\nsteps:\n  - id: inspect\n    run: echo ok\n',
	}));
  });

  test('does not repeat a committed save when the list refresh fails', async () => {
    const playbook = playbookFixtureData.playbooks[0];
    const baseGateway = createFixturePlaybookGateway({ latencyMs: 0 });
    const updatePlaybook = jest.fn(baseGateway.updatePlaybook);
    const gateway: PlaybookGateway = { ...baseGateway, updatePlaybook };
    render(
      <MemoryRouter>
        <PlaybookEditor
          folders={[]}
          gateway={gateway}
          onSaved={async () => {
            throw new Error('refresh unavailable');
          }}
          playbook={playbook}
        />
      </MemoryRouter>
    );

    fireEvent.change(screen.getByRole('textbox', { name: 'Playbook description' }), {
      target: { value: 'committed description' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: '变更说明' }), {
      target: { value: '测试已保存状态' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByRole('button', { name: '已保存' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('已保存，但列表刷新失败');
    fireEvent.click(screen.getByRole('button', { name: '已保存' }));
    expect(updatePlaybook).toHaveBeenCalledTimes(1);
  });

  test('does not reuse a stale Config draft after changing Step type', async () => {
    const playbook = playbookFixtureData.playbooks[0];
    const baseGateway = createFixturePlaybookGateway({
      latencyMs: 0,
      storageKey: `torchbearing.type-change.${storageSequence++}`,
    });
    const updatePlaybook = jest.fn(baseGateway.updatePlaybook);
    const gateway: PlaybookGateway = { ...baseGateway, updatePlaybook };
    render(
      <MemoryRouter>
        <PlaybookEditor folders={[]} gateway={gateway} onSaved={async () => undefined} playbook={playbook} />
      </MemoryRouter>
    );

    fireEvent.change(await screen.findByRole('textbox', { name: 'Step 1 config' }), {
      target: { value: '{"expr":"stale-after-type-change"}' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Step 1 type' }), { target: { value: 'template' } });
    fireEvent.change(screen.getByRole('textbox', { name: '变更说明' }), { target: { value: '切换 Step 类型' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await screen.findByRole('button', { name: '已保存' });
    expect(updatePlaybook).toHaveBeenCalledTimes(1);
    const input = updatePlaybook.mock.calls[0][1] as { steps: Array<{ type: string; config: Record<string, unknown> }> };
    expect(input.steps[0]).toMatchObject({ type: 'template', config: { template: '# Result' } });
  });

  test('uses the resource Folder permission instead of the active topbar Folder', async () => {
    renderPage('/a/grafana-plugin-app/playbooks/pb-002');

    expect(await screen.findByText('pg-connection-pool-debug', { selector: 'code' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '编辑' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '预览运行' })).toBeEnabled();
  });

  test('does not expose the editor through a direct route for a View-only Playbook', async () => {
    renderPage('/a/grafana-plugin-app/playbooks/pb-002/edit');

    expect(await screen.findByText('pg-connection-pool-debug', { selector: 'code' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Playbook name' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '编辑' })).toBeDisabled();
  });

  test('creates a private playbook and restores it after navigation', async () => {
    renderPage('/a/grafana-plugin-app/playbooks');
    await screen.findByText('5 个 playbook');
    fireEvent.click(screen.getByRole('button', { name: '新建 Playbook' }));

    fireEvent.change(await screen.findByRole('textbox', { name: 'Playbook name' }), {
      target: { value: 'new-checkout-playbook' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Playbook description' }), {
      target: { value: '新的 Checkout 排查流程' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText('new-checkout-playbook', { selector: 'code' })).toBeInTheDocument();
    expect(screen.getByText('新的 Checkout 排查流程')).toBeInTheDocument();
  });

  test('edits a playbook and exposes the saved revision', async () => {
    renderPage('/a/grafana-plugin-app/playbooks/pb-001');
    await screen.findByText('checkout-latency-investigation', { selector: 'code' });
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));

    fireEvent.change(await screen.findByRole('textbox', { name: 'Playbook description' }), {
      target: { value: '更新后的 Checkout 排查流程' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: '变更说明' }), {
      target: { value: '补充 Checkout 说明' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText('更新后的 Checkout 排查流程')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /经验/ }));
    const history = screen.getByRole('dialog', { name: /版本历史/ });
    expect(within(history).getByText('补充 Checkout 说明')).toBeInTheDocument();
    expect(within(history).getByText(/v1.3.1/)).toBeInTheDocument();
  });

  test('generates a private draft from a selected Workbench session', async () => {
    renderPage('/a/grafana-plugin-app/playbooks');
    await screen.findByText('5 个 playbook');
    fireEvent.click(screen.getByRole('button', { name: '从对话沉淀' }));
    const dialog = await screen.findByRole('dialog', { name: '从对话沉淀 Playbook' });
    await within(dialog).findByRole('option', { name: /Checkout 服务 p95 延迟排查/ });
    fireEvent.click(within(dialog).getByRole('button', { name: '生成草稿' }));

    expect(await screen.findByRole('textbox', { name: 'Playbook description' })).toHaveValue(
      '从会话“Checkout 服务 p95 延迟排查”沉淀的结构化排查流程'
    );
    expect(screen.getByRole('combobox', { name: 'Playbook visibility' })).toHaveValue('private');
  });

  test('runs through a side-effect HITL and restores the result', async () => {
    renderPage('/a/grafana-plugin-app/playbooks/pb-001');
    await screen.findByText('checkout-latency-investigation', { selector: 'code' });
    fireEvent.click(screen.getByRole('button', { name: '预览运行' }));
    const setup = screen.getByRole('dialog', { name: '运行 checkout-latency-investigation' });
    fireEvent.click(within(setup).getByRole('button', { name: '开始预览' }));

    expect(await screen.findByText(/需要确认/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '批准模拟执行' }));
    const result = await screen.findByRole('region', { name: 'Playbook 执行结果' });
    expect(await within(result).findByText('success', { selector: '.playbook-run-status' })).toBeInTheDocument();
    expect(within(result).getByText('已确认 · 未执行真实更改')).toBeInTheDocument();
  });

  test('does not let a stale draft response reopen a removed draft route', async () => {
    let resolveDraft!: (draft: PlaybookDraft) => void;
    const baseGateway = createFixturePlaybookGateway({ latencyMs: 0 });
    const gateway: PlaybookGateway = {
      ...baseGateway,
      getDraft: jest.fn(() => new Promise<PlaybookDraft>((resolve) => {
        resolveDraft = resolve;
      })),
    };
    const { rerender } = render(
      <MemoryRouter initialEntries={['/a/grafana-plugin-app/playbooks/new?draft=draft-stale']}>
        <PlaybookEditor draftId="draft-stale" folders={[]} gateway={gateway} onSaved={async () => undefined} />
      </MemoryRouter>
    );

    expect(screen.getByText('正在加载对话草稿…')).toBeInTheDocument();
    rerender(
      <MemoryRouter initialEntries={['/a/grafana-plugin-app/playbooks/new']}>
        <PlaybookEditor folders={[]} gateway={gateway} onSaved={async () => undefined} />
      </MemoryRouter>
    );
    expect(await screen.findByRole('textbox', { name: 'Playbook name' })).toHaveValue('');

    await act(async () => resolveDraft(draft('stale-draft')));
    expect(screen.getByRole('textbox', { name: 'Playbook name' })).toHaveValue('');
  });

  test('blocks the editor after a draft load failure and can retry', async () => {
    const baseGateway = createFixturePlaybookGateway({ latencyMs: 0 });
    let attempts = 0;
    const gateway: PlaybookGateway = {
      ...baseGateway,
      getDraft: jest.fn(async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('draft service unavailable');
        }
        return draft('recovered-draft');
      }),
    };

    render(
      <MemoryRouter initialEntries={['/a/grafana-plugin-app/playbooks/new?draft=draft-retry']}>
        <PlaybookEditor draftId="draft-retry" folders={[]} gateway={gateway} onSaved={async () => undefined} />
      </MemoryRouter>
    );

    expect(await screen.findByRole('alert', { name: '草稿加载错误' })).toHaveTextContent('draft service unavailable');
    expect(screen.queryByRole('textbox', { name: 'Playbook name' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '保存' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '重试加载草稿' }));
    expect(await screen.findByRole('textbox', { name: 'Playbook name' })).toHaveValue('recovered-draft');
    expect(gateway.getDraft).toHaveBeenCalledTimes(2);
  });
});

function renderPage(initialEntry: string) {
  const storageKey = `torchbearing.fixture.playbooks.test.${storageSequence++}`;
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AppServicesProvider
		runtimeMode="fixture"
        services={{
          folderGateway: createFixtureFolderGateway({ latencyMs: 0 }),
          playbookGateway: createFixturePlaybookGateway({ latencyMs: 0, storageKey, streamDelayMs: 0 }),
          workbenchGateway: createFixtureWorkbenchGateway({
            latencyMs: 0,
            streamDelayMs: 0,
            storageKey: `${storageKey}.workbench`,
          }),
        }}
      >
        <AppShellProvider>
          <AppShell>
            <Routes>
              <Route element={<PlaybooksPage />} path="/a/grafana-plugin-app/playbooks" />
              <Route element={<PlaybooksPage />} path="/a/grafana-plugin-app/playbooks/*" />
            </Routes>
          </AppShell>
        </AppShellProvider>
      </AppServicesProvider>
    </MemoryRouter>
  );
}

function draft(name: string): PlaybookDraft {
  return {
    id: 'draft-stale',
    sourceSessionId: 's-001',
    sourceSessionTitle: 'Session',
    ownerId: 'alice',
    changeNote: 'from session',
    createdAt: '2026-07-25T00:00:00.000Z',
    name,
    description: 'Draft description',
    version: '0.1',
    trigger: { type: 'manual', alertLabels: {} },
    parameters: [],
    steps: [],
    experience: [],
    visibility: 'private',
  };
}
