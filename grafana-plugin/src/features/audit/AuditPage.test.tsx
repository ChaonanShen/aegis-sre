import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppServicesProvider } from '../../app/AppServices';
import { createFixtureAuditStore } from '../../fixtures/fixtureAuditStore';
import { createFixtureAuditGateway } from './adapters/fixtureAuditGateway';
import AuditPage from './AuditPage';
import { AuditExportFile, AuditQueryResult } from './model';

const fixedNow = () => new Date('2026-07-25T08:00:00.000Z');

describe('AuditPage', () => {
  test('renders KPIs and applies combined filters', async () => {
    renderPage();
    expect(await screen.findByText('1,247')).toBeInTheDocument();
    expect(screen.getByText(/^9 条/)).toBeInTheDocument();
    expect(screen.getByText('时间', { selector: '.audit-filter-field > span' })).toBeInTheDocument();
    expect(screen.getByText('事件类型', { selector: '.audit-filter-field > span' })).toBeInTheDocument();
    expect(screen.getByText('Actor', { selector: '.audit-filter-field > span' })).toBeInTheDocument();
    expect(screen.getByText('结果', { selector: '.audit-filter-field > span' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('搜索审计事件'), { target: { value: 'prometheus' } });
    fireEvent.change(screen.getByLabelText('审计事件类型'), { target: { value: 'tool_call' } });
    expect(await screen.findByText(/^1 条/)).toBeInTheDocument();
    expect(screen.getByText('grafana.query_prometheus')).toBeInTheDocument();
  });

  test('shows dynamically appended approval events', async () => {
    const storage = memoryStorage();
    createFixtureAuditStore({ storage, now: fixedNow }).append({
      id: 'approval-new',
      occurredAt: '2026-07-25T09:00:00.000Z',
      type: 'object_promote_approved',
      actor: 'alice',
      target: 'playbook/pb-008',
      detail: 'Approved by alice',
      outcome: 'ok',
    });
    renderPage(storage);
    expect(await screen.findByText('playbook/pb-008')).toBeInTheDocument();
  });

  test('downloads the current filtered result and revokes the URL', async () => {
    const createUrl = jest.fn(() => 'blob:test');
    const revoke = jest.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createUrl });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
    const click = jest.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation();
    renderPage();
    await screen.findByText(/^9 条/);
    fireEvent.change(screen.getByLabelText('审计结果'), { target: { value: 'rejected' } });
    await screen.findByText(/^1 条/);
    fireEvent.click(screen.getByRole('button', { name: '导出' }));
    await waitFor(() => expect(createUrl).toHaveBeenCalled());
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe('audit-2026-07-25.csv');
    expect(revoke).toHaveBeenCalledWith('blob:test');
    jest.restoreAllMocks();
  });

  test('does not let a stale query replace the newest filter result', async () => {
    const first = deferred<AuditQueryResult>();
    const second = deferred<AuditQueryResult>();
    const third = deferred<AuditQueryResult>();
    const base = createFixtureAuditGateway({ latencyMs: 0, now: fixedNow });
    let calls = 0;
    const queryAudit = jest.fn(() => {
      calls += 1;
      return calls === 1 ? first.promise : calls === 2 ? second.promise : third.promise;
    });
    render(
      <AppServicesProvider services={{ auditGateway: { ...base, queryAudit } }}>
        <AuditPage />
      </AppServicesProvider>
    );

    await waitFor(() => expect(queryAudit).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText('搜索审计事件'), { target: { value: 'old' } });
    await waitFor(() => expect(queryAudit).toHaveBeenCalledTimes(2));
    fireEvent.change(screen.getByLabelText('搜索审计事件'), { target: { value: 'new' } });
    await waitFor(() => expect(queryAudit).toHaveBeenCalledTimes(3));

    await act(async () => third.resolve(auditResult('new-target')));
    await waitFor(() => expect(screen.getAllByText('new-target').length).toBeGreaterThan(0));
    await act(async () => {
      first.resolve(auditResult('old-target'));
      second.resolve(auditResult('old-target-2'));
    });

    expect(screen.getAllByText('new-target').length).toBeGreaterThan(0);
    expect(screen.queryByText('old-target')).not.toBeInTheDocument();
    expect(screen.queryByText('old-target-2')).not.toBeInTheDocument();
  });

  test('cancels an in-flight export when the page unmounts', async () => {
    const exported = deferred<AuditExportFile>();
    let exportSignal: AbortSignal | undefined;
    const base = createFixtureAuditGateway({ latencyMs: 0, now: fixedNow });
    const exportAudit = jest.fn((_query, signal?: AbortSignal) => {
      exportSignal = signal;
      return exported.promise;
    });
    const view = render(
      <AppServicesProvider services={{ auditGateway: { ...base, exportAudit } }}>
        <AuditPage />
      </AppServicesProvider>
    );
    await screen.findByText(/^9 条/);

    fireEvent.click(screen.getByRole('button', { name: '导出' }));
    fireEvent.click(screen.getByRole('button', { name: '导出中…' }));
    expect(exportAudit).toHaveBeenCalledTimes(1);
    expect(exportSignal).toBeInstanceOf(AbortSignal);

    view.unmount();
    expect(exportSignal?.aborted).toBe(true);
  });
});
function renderPage(storage = memoryStorage()) {
  return render(
    <AppServicesProvider
      services={{ auditGateway: createFixtureAuditGateway({ storage, latencyMs: 0, now: fixedNow }) }}
    >
      <AuditPage />
    </AppServicesProvider>
  );
}
function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

function auditResult(target: string): AuditQueryResult {
  return {
    events: [
      {
        id: target,
        occurredAt: '2026-07-25T08:00:00.000Z',
        type: 'tool_call',
        actor: 'tester',
        target,
        detail: target,
        outcome: 'ok',
      },
    ],
    filteredCount: 1,
    summary: { todayEvents: 1, llmCalls: 0, hitlDecisions: 0, failovers: 0 },
    retention: { fileName: 'audit-test.log', retentionDays: 30, coverage: ['tool_call'] },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
