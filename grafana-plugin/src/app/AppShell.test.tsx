import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppServicesProvider, RuntimeMode } from './AppServices';
import { AppShell } from './AppShell';
import { AppShellProvider, useAppShell } from './AppShellContext';
import { createFixtureWorkbenchGateway } from '../features/workbench/adapters/fixtureWorkbenchGateway';

const folders = [
  { uid: 'payment', title: 'Payment', permission: 'Edit' as const, serviceCount: 8 },
  { uid: 'infra', title: 'Infra', permission: 'View' as const, serviceCount: 5 },
];

describe('AppShell', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  test('uses Infra by default and persists a folder change', async () => {
    renderShell();

    await screen.findByText('Folder: Infra');
    expect(screen.getByLabelText('演示数据模式')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Folder: Infra/ }));
    fireEvent.click(screen.getByRole('button', { name: /Payment/ }));

    await waitFor(() => expect(screen.getByText('Folder: Payment')).toBeInTheDocument());
    expect(window.sessionStorage.getItem('torchbearing.fixture.shell.v1')).toBe('payment');
  });

  test('filters folders in the dropdown', async () => {
    renderShell();

    await screen.findByText('Folder: Infra');
    fireEvent.click(screen.getByRole('button', { name: /Folder: Infra/ }));
    fireEvent.change(screen.getByRole('textbox', { name: '搜索 Folder' }), { target: { value: 'pay' } });
    const dialog = screen.getByRole('dialog', { name: '选择 Folder' });

    expect(within(dialog).getByRole('button', { name: /Payment/ })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: /Infra/ })).not.toBeInTheDocument();
  });

  test('restores focus and clears the search when the Folder dropdown closes', async () => {
    renderShell();

    const trigger = await screen.findByRole('button', { name: /Folder: Infra/ });
    fireEvent.click(trigger);
    fireEvent.change(screen.getByRole('textbox', { name: '搜索 Folder' }), { target: { value: 'pay' } });
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('dialog', { name: '选择 Folder' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    const reopened = screen.getByRole('dialog', { name: '选择 Folder' });
    expect(screen.getByRole('textbox', { name: '搜索 Folder' })).toHaveValue('');
    expect(within(reopened).getByRole('button', { name: /Infra/ })).toBeInTheDocument();
  });

  test('keeps navigation reachable when the desktop rail is hidden', () => {
    renderShell();

    const toggle = screen.getByRole('button', { name: '打开功能导航' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(toggle);
    const dialog = screen.getByRole('dialog', { name: 'Aegis SRE 功能导航' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(within(dialog).getByRole('link', { name: '知识库' })).toHaveAttribute(
      'href',
      expect.stringContaining('/knowledge')
    );
    expect(within(dialog).getByRole('link', { name: '设置' })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Aegis SRE 功能导航' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '打开功能导航' })).toHaveAttribute('aria-expanded', 'false');
    expect(document.activeElement).toBe(toggle);
  });

  test('ignores Folder ids that are not visible to the current user', async () => {
    renderShell();
    await screen.findByText('success:infra');

    fireEvent.click(screen.getByTestId('set-invalid-folder'));

    expect(screen.getByText('success:infra')).toBeInTheDocument();
    expect(window.sessionStorage.getItem('torchbearing.fixture.shell.v1')).toBeNull();
  });

  test('does not expose fixture Folder controls in real mode', async () => {
    renderShell('real');

    await screen.findByText('error:none');
    expect(screen.queryByRole('button', { name: /Folder:/ })).not.toBeInTheDocument();
    expect(screen.queryByText('权限来自 Grafana Folder')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('演示数据模式')).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem('torchbearing.fixture.shell.v1')).toBeNull();
  });

  test('does not let a stale Folder refresh replace the latest result', async () => {
    const first = deferred<typeof folders>();
    const second = deferred<typeof folders>();
    let calls = 0;
    const folderGateway = {
      listFolders: jest.fn(() => {
        calls += 1;
        return calls === 1 ? first.promise : second.promise;
      }),
    };

    render(
      <MemoryRouter initialEntries={['/workbench']}>
        <AppServicesProvider
          runtimeMode="fixture"
          services={{
            folderGateway,
            workbenchGateway: createFixtureWorkbenchGateway({ latencyMs: 0, streamDelayMs: 0 }),
          }}
        >
          <AppShellProvider>
            <FolderProbe />
          </AppShellProvider>
        </AppServicesProvider>
      </MemoryRouter>
    );

    await waitFor(() => expect(folderGateway.listFolders).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '刷新 Folder' }));
    await waitFor(() => expect(folderGateway.listFolders).toHaveBeenCalledTimes(2));

    await act(async () => first.resolve([{ ...folders[0], title: '旧结果' }]));
    expect(screen.queryByText(/旧结果/)).not.toBeInTheDocument();

    await act(async () => second.resolve([{ ...folders[1], title: '新结果' }]));
    await waitFor(() => expect(screen.getByText(/新结果/)).toBeInTheDocument());
    expect(screen.queryByText(/旧结果/)).not.toBeInTheDocument();
  });
});

function renderShell(runtimeMode: RuntimeMode = 'fixture') {
  return render(
    <MemoryRouter initialEntries={['/workbench']}>
      <AppServicesProvider
        runtimeMode={runtimeMode}
        services={{
          ...(runtimeMode === 'fixture' ? { folderGateway: { listFolders: async () => folders } } : {}),
          workbenchGateway: createFixtureWorkbenchGateway({ latencyMs: 0, streamDelayMs: 0 }),
        }}
      >
        <AppShellProvider>
          <AppShell>
            <div>content</div>
            <ShellState />
          </AppShell>
        </AppShellProvider>
      </AppServicesProvider>
    </MemoryRouter>
  );
}

function ShellState() {
  const { activeFolder, folders: state, setActiveFolder } = useAppShell();
  return (
    <>
      <span>{`${state.status}:${activeFolder?.uid ?? 'none'}`}</span>
      <button data-testid="set-invalid-folder" onClick={() => setActiveFolder('not-visible')} type="button">
        invalid folder
      </button>
    </>
  );
}

function FolderProbe() {
  const { folders: state, refreshFolders } = useAppShell();
  return (
    <>
      <span>{state.status === 'success' ? state.data.map(({ title }) => title).join(',') : state.status}</span>
      <button aria-label="刷新 Folder" onClick={refreshFolders} type="button">
        刷新
      </button>
    </>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
