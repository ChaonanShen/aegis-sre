import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { createFixtureFolderGateway } from '../../app/adapters/fixtureFolderGateway';
import { AppServicesProvider } from '../../app/AppServices';
import { AppShell } from '../../app/AppShell';
import { AppShellProvider } from '../../app/AppShellContext';
import { createFixtureApprovalGateway } from './adapters/fixtureApprovalGateway';
import { Approval } from './model';
import { ApprovalGateway } from './ports/ApprovalGateway';
import ApprovalsPage from './ApprovalsPage';

describe('ApprovalsPage', () => {
  test('renders KPIs, filters, previews, and permission-disabled actions', async () => {
    renderPage();
    expect(await screen.findByText('search-index-lag-review')).toBeInTheDocument();
    expect(screen.getByText('4', { selector: 'strong' })).toBeInTheDocument();
    const disabledCard = screen.getByText('private-incident-2026-07-21').closest('article') as HTMLElement;
    expect(within(disabledCard).getByRole('button', { name: '通过' })).toBeDisabled();
    const previewTrigger = within(disabledCard).getByRole('button', { name: '查看完整草稿' });
    previewTrigger.focus();
    fireEvent.click(previewTrigger);
    const preview = screen.getByRole('dialog', { name: 'private-incident-2026-07-21 完整草稿' });
    expect(preview).toHaveAttribute('aria-modal', 'true');
    expect(preview).toHaveTextContent('YAML');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'private-incident-2026-07-21 完整草稿' })).not.toBeInTheDocument();
    expect(previewTrigger).toHaveFocus();

    fireEvent.change(screen.getByLabelText('审批对象类型'), { target: { value: 'skill' } });
    expect(await screen.findByText('my-personal-debug')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('search-index-lag-review')).not.toBeInTheDocument());
  });

  test('validates rejection reason and persists a rejection', async () => {
    renderPage();
    const card = (await screen.findByText('search-index-lag-review')).closest('article') as HTMLElement;
    const rejectTrigger = within(card).getByRole('button', { name: '拒绝' });
    rejectTrigger.focus();
    fireEvent.click(rejectTrigger);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '拒绝 search-index-lag-review' })).not.toBeInTheDocument();
    expect(rejectTrigger).toHaveFocus();
    fireEvent.click(rejectTrigger);
    const reopenedDialog = screen.getByRole('dialog', { name: '拒绝 search-index-lag-review' });
    expect(within(reopenedDialog).getByRole('button', { name: '确认拒绝' })).toBeDisabled();
    fireEvent.change(within(reopenedDialog).getByLabelText('拒绝原因'), { target: { value: '请补充回滚步骤' } });
    fireEvent.click(within(reopenedDialog).getByRole('button', { name: '确认拒绝' }));
    await waitFor(() => expect(screen.queryByText('search-index-lag-review')).not.toBeInTheDocument());
    fireEvent.click(await screen.findByRole('button', { name: 'rejected' }));
    const rejectedCard = (await screen.findByText('search-index-lag-review')).closest('article') as HTMLElement;
    expect(rejectedCard).toHaveTextContent('请补充回滚步骤');
  });

  test('approves after confirmation and removes the item from pending', async () => {
    jest.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    const card = (await screen.findByText('search-index-lag-review')).closest('article') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: '通过' }));
    await waitFor(() => expect(screen.queryByText('search-index-lag-review')).not.toBeInTheDocument());
    expect(window.confirm).toHaveBeenCalled();
    jest.restoreAllMocks();
  });

  test('does not submit the same approval twice while the first decision is pending', async () => {
    const storage = memoryStorage();
    const base = createFixtureApprovalGateway({ storage, storageKey: 'approvals-duplicate', latencyMs: 0 });
    const result = deferred<Approval>();
    const approve = jest.fn(() => result.promise);
    const approvalGateway: ApprovalGateway = { ...base, approve };
    jest.spyOn(window, 'confirm').mockReturnValue(true);

    renderPage(approvalGateway);
    const card = (await screen.findByText('search-index-lag-review')).closest('article') as HTMLElement;
    const button = within(card).getByRole('button', { name: '通过' });
    fireEvent.click(button);
    fireEvent.click(button);

    await waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
    expect(button).toBeDisabled();
    await act(async () => result.resolve({} as Approval));
    const reloadedCard = (await screen.findByText('search-index-lag-review')).closest('article') as HTMLElement;
    expect(within(reloadedCard).getByRole('button', { name: '通过' })).toBeEnabled();
    jest.restoreAllMocks();
  });

  test('reloads using the latest filter after a decision started on an older view', async () => {
    const storage = memoryStorage();
    const base = createFixtureApprovalGateway({ storage, storageKey: 'approvals-race', latencyMs: 0 });
    const approvalResult = deferred<Approval>();
    let approveInput!: Parameters<ApprovalGateway['approve']>[0];
    const approvalGateway: ApprovalGateway = {
      ...base,
      approve: jest.fn((input) => {
        approveInput = input;
        return approvalResult.promise;
      }),
    };
    jest.spyOn(window, 'confirm').mockReturnValue(true);

    renderPage(approvalGateway);
    const card = (await screen.findByText('search-index-lag-review')).closest('article') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: '通过' }));
    await waitFor(() => expect(approvalGateway.approve).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'approved' }));
    await waitFor(() => expect(screen.queryByText('search-index-lag-review')).not.toBeInTheDocument());

    await act(async () => approvalResult.resolve(await base.approve(approveInput)));
    expect(await screen.findByText('search-index-lag-review')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'approved' })).toHaveAttribute('aria-pressed', 'true');
    jest.restoreAllMocks();
  });

  test('closes an open draft preview when the approval scope changes', async () => {
    renderPage();
    const card = (await screen.findByText('search-index-lag-review')).closest('article') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: '查看完整草稿' }));
    expect(screen.getByRole('dialog', { name: 'search-index-lag-review 完整草稿' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('审批对象类型'), { target: { value: 'skill' } });
    expect(screen.queryByRole('dialog', { name: 'search-index-lag-review 完整草稿' })).not.toBeInTheDocument();
    expect(await screen.findByText('my-personal-debug')).toBeInTheDocument();
  });

  test('closes an open rejection form when the status scope changes', async () => {
    renderPage();
    const card = (await screen.findByText('search-index-lag-review')).closest('article') as HTMLElement;
    fireEvent.click(within(card).getByRole('button', { name: '拒绝' }));
    const dialog = screen.getByRole('dialog', { name: '拒绝 search-index-lag-review' });
    fireEvent.change(within(dialog).getByLabelText('拒绝原因'), { target: { value: '旧范围原因' } });

    fireEvent.click(screen.getByRole('button', { name: 'approved' }));
    expect(screen.queryByRole('dialog', { name: '拒绝 search-index-lag-review' })).not.toBeInTheDocument();
    expect(await screen.findByText('search-index-lag-review')).toBeInTheDocument();
  });
});

function renderPage(approvalGateway?: ApprovalGateway) {
  const storage = memoryStorage();
  return render(
    <MemoryRouter>
      <AppServicesProvider
        services={{
          approvalGateway:
            approvalGateway ??
            createFixtureApprovalGateway({
              storage,
              storageKey: 'approvals-ui',
              latencyMs: 0,
              now: () => new Date('2026-07-25T08:00:00.000Z'),
              newId: () => 'audit-ui',
            }),
          folderGateway: createFixtureFolderGateway({ latencyMs: 0 }),
        }}
      >
        <AppShellProvider>
          <AppShell>
            <ApprovalsPage />
          </AppShell>
        </AppShellProvider>
      </AppServicesProvider>
    </MemoryRouter>
  );
}

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
