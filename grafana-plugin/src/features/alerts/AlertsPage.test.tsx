import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { createFixtureFolderGateway } from '../../app/adapters/fixtureFolderGateway';
import { AppServicesProvider } from '../../app/AppServices';
import { AppShellProvider } from '../../app/AppShellContext';
import { createFixtureKnowledgeGateway } from '../knowledge/adapters/fixtureKnowledgeGateway';
import { CreateRunbookInput, Runbook } from '../knowledge/model';
import { KnowledgeGateway } from '../knowledge/ports/KnowledgeGateway';
import { createFixtureAlertGateway } from './adapters/fixtureAlertGateway';
import { AlertListResult, AlertRefreshResult } from './model';
import { AlertGateway } from './ports/AlertGateway';
import AlertsPage from './AlertsPage';

describe('AlertsPage', () => {
  test('renders route-backed detail, filters, and full analysis', async () => {
    renderPage('/a/grafana-plugin-app/alerts/al-002');
    expect(await screen.findByRole('heading', { name: 'PaymentErrorRate' })).toBeInTheDocument();
    expect(screen.getByText('处理流水线')).toBeInTheDocument();
    expect(screen.getByText('状态', { selector: '.alert-filter-field > span' })).toBeInTheDocument();
    expect(screen.getByText('严重度', { selector: '.alert-filter-field > span' })).toBeInTheDocument();
    expect(screen.getByText('Folder', { selector: '.alert-filter-field > span' })).toBeInTheDocument();
    const analysisTrigger = screen.getByRole('button', { name: '查看完整分析' });
    analysisTrigger.focus();
    fireEvent.click(analysisTrigger);
    const analysisDialog = screen.getByRole('dialog', { name: 'PaymentErrorRate 完整分析' });
    expect(analysisDialog).toHaveAttribute('aria-modal', 'true');
    expect(analysisDialog).toHaveTextContent(
      '执行会修改数据的步骤前仍会请求确认'
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'PaymentErrorRate 完整分析' })).not.toBeInTheDocument();
    expect(analysisTrigger).toHaveFocus();
    fireEvent.change(screen.getByLabelText('告警严重度'), { target: { value: 'info' } });
    expect(await screen.findByText('KafkaLagHigh')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '分析失败' })).toBeInTheDocument();
  });

  test('refreshes deterministic state and exposes recommendation', async () => {
    renderPage('/a/grafana-plugin-app/alerts/al-001');
    expect(await screen.findByRole('heading', { name: 'CheckoutLatencyHigh' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    expect(await screen.findByText(/推荐 Playbook：checkout-latency-investigation/)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('已推进 2 条告警');
  });

  test('saves analyzed output as a runbook when Folder is writable', async () => {
    const view = renderPage('/a/grafana-plugin-app/alerts/al-002');
    const button = await screen.findByRole('button', { name: '沉淀为 Runbook' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(view.routerLocation()).toContain('/knowledge?tab=runbooks&runbook='));
  });

  test('does not navigate to an undefined recommendation when no Playbook is linked', async () => {
    const storage = memoryStorage();
    const base = createFixtureAlertGateway({ storage, latencyMs: 0 });
    const alertGateway: AlertGateway = {
      ...base,
      async getAlert(id, signal) {
        const detail = await base.getAlert(id, signal);
        return { ...detail, recommendedPlaybookId: undefined, recommendedPlaybookName: undefined };
      },
    };

    renderPage('/a/grafana-plugin-app/alerts/al-002', { alertGateway });
    expect(await screen.findByRole('heading', { name: 'PaymentErrorRate' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /推荐 Playbook/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '查看完整分析' }));
    expect(screen.getByRole('dialog', { name: 'PaymentErrorRate 完整分析' })).not.toHaveTextContent('undefined');
  });

  test('locks Runbook save while the request is pending', async () => {
    const storage = memoryStorage();
    const base = createFixtureKnowledgeGateway({ storage, latencyMs: 0, newId: () => 'rb-locked' });
    let resolveCreate!: (runbook: Runbook) => void;
    const createRunbook = jest.fn(
      (_input: CreateRunbookInput) =>
        new Promise<Runbook>((resolve) => {
          resolveCreate = resolve;
        })
    );
    const knowledgeGateway: KnowledgeGateway = { ...base, createRunbook };

    renderPage('/a/grafana-plugin-app/alerts/al-002', { knowledgeGateway });
    const button = await screen.findByRole('button', { name: '沉淀为 Runbook' });
    fireEvent.click(button);
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(createRunbook).toHaveBeenCalledTimes(1);

    const input = createRunbook.mock.calls[0][0];
    const saved = await base.createRunbook(input);
    resolveCreate(saved);
    await waitFor(() => expect(screen.queryByRole('button', { name: '沉淀为 Runbook' })).not.toBeInTheDocument());
  });

  test('ignores a stale list response after the filter changes', async () => {
    const storage = memoryStorage();
    const base = createFixtureAlertGateway({ storage, latencyMs: 0 });
    const warning = deferred<AlertListResult>();
    const info = deferred<AlertListResult>();
    const listAlerts = jest.fn((nextQuery: Parameters<AlertGateway['listAlerts']>[0], signal?: AbortSignal) => {
      if (nextQuery.severity === 'info') {
        return info.promise;
      }
      if (nextQuery.severity === 'warning') {
        return warning.promise;
      }
      return base.listAlerts(nextQuery, signal);
    });
    const alertGateway: AlertGateway = { ...base, listAlerts };

    renderPage('/a/grafana-plugin-app/alerts/al-001', { alertGateway });
    expect(await screen.findByRole('heading', { name: 'CheckoutLatencyHigh' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('告警严重度'), { target: { value: 'warning' } });
    await waitFor(() => expect(listAlerts).toHaveBeenCalledWith({ severity: 'warning' }, expect.any(AbortSignal)));
    fireEvent.change(screen.getByLabelText('告警严重度'), { target: { value: 'info' } });
    await waitFor(() => expect(listAlerts).toHaveBeenCalledWith({ severity: 'info' }, expect.any(AbortSignal)));

    await act(async () => info.resolve(await base.listAlerts({ severity: 'info' })));
    expect(await screen.findByRole('heading', { name: 'KafkaLagHigh' })).toBeInTheDocument();
    await act(async () => warning.resolve(await base.listAlerts({ severity: 'warning' })));

    await waitFor(() => expect(screen.getByRole('heading', { name: 'KafkaLagHigh' })).toBeInTheDocument());
    expect(screen.queryByRole('heading', { name: 'CheckoutLatencyHigh' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('告警严重度')).toHaveValue('info');
    expect(listAlerts.mock.calls.filter(([nextQuery]) => nextQuery.severity === 'info')).toHaveLength(1);
  });

  test('does not reload the old filter when refresh finishes after a filter change', async () => {
    const storage = memoryStorage();
    const base = createFixtureAlertGateway({ storage, latencyMs: 0 });
    const refresh = deferred<AlertRefreshResult>();
    const listAlerts = jest.fn((nextQuery: Parameters<AlertGateway['listAlerts']>[0], signal?: AbortSignal) =>
      base.listAlerts(nextQuery, signal)
    );
    const alertGateway: AlertGateway = {
      ...base,
      listAlerts,
      refreshAlerts: jest.fn(() => refresh.promise),
    };

    renderPage('/a/grafana-plugin-app/alerts/al-001', { alertGateway });
    expect(await screen.findByRole('heading', { name: 'CheckoutLatencyHigh' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(alertGateway.refreshAlerts).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('告警严重度'), { target: { value: 'info' } });
    expect(await screen.findByRole('heading', { name: 'KafkaLagHigh' })).toBeInTheDocument();

    await act(async () => refresh.resolve({ alerts: [], changedIds: [] }));
    await waitFor(() => expect(screen.getByLabelText('告警严重度')).toHaveValue('info'));
    expect(screen.queryByRole('heading', { name: 'CheckoutLatencyHigh' })).not.toBeInTheDocument();
    expect(listAlerts.mock.calls.filter(([nextQuery]) => !nextQuery.severity)).toHaveLength(1);
  });

  test('closes the analysis dialog when the alert scope changes', async () => {
    renderPage('/a/grafana-plugin-app/alerts/al-002');
    expect(await screen.findByRole('heading', { name: 'PaymentErrorRate' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '查看完整分析' }));
    expect(screen.getByRole('dialog', { name: 'PaymentErrorRate 完整分析' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('告警严重度'), { target: { value: 'info' } });
    expect(screen.queryByRole('dialog', { name: 'PaymentErrorRate 完整分析' })).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '分析失败' })).toBeInTheDocument();
    expect(screen.getByLabelText('告警严重度')).toHaveValue('info');
  });

  test('does not navigate after a Runbook save resolves for an old alert scope', async () => {
    const storage = memoryStorage();
    const base = createFixtureKnowledgeGateway({ storage, latencyMs: 0 });
    const pending = deferred<Runbook>();
    const createRunbook = jest.fn(() => pending.promise);
    const knowledgeGateway: KnowledgeGateway = { ...base, createRunbook };

    renderPage('/a/grafana-plugin-app/alerts/al-002', { knowledgeGateway });
    const save = await screen.findByRole('button', { name: '沉淀为 Runbook' });
    fireEvent.click(save);
    expect(createRunbook).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText('告警严重度'), { target: { value: 'info' } });
    expect(await screen.findByRole('heading', { name: 'KafkaLagHigh' })).toBeInTheDocument();

    await act(async () => pending.resolve({ id: 'stale-runbook' } as Runbook));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'KafkaLagHigh' })).toBeInTheDocument());
    expect(screen.queryByText('知识库')).not.toBeInTheDocument();
  });
});

function renderPage(
  initial: string,
  overrides: { alertGateway?: AlertGateway; knowledgeGateway?: KnowledgeGateway } = {}
) {
  const storage = memoryStorage();
  let path = initial;
  const result = render(
    <MemoryRouter initialEntries={[initial]}>
      <AppServicesProvider
        services={{
          alertGateway:
            overrides.alertGateway ??
            createFixtureAlertGateway({
              storage,
              storageKey: 'alerts-ui',
              latencyMs: 0,
              now: () => new Date('2026-07-25T08:00:00.000Z'),
              newId: (prefix) => `${prefix}-ui`,
            }),
          folderGateway: createFixtureFolderGateway({ latencyMs: 0 }),
          knowledgeGateway:
            overrides.knowledgeGateway ??
            createFixtureKnowledgeGateway({
              storage,
              storageKey: 'knowledge-ui',
              latencyMs: 0,
              newId: () => 'rb-alert',
            }),
        }}
      >
        <AppShellProvider>
          <Routes>
            <Route path="/a/grafana-plugin-app/alerts/:alertId?" element={<AlertsPage />} />
            <Route
              path="*"
              element={
                <LocationProbe
                  onChange={(value) => {
                    path = value;
                  }}
                />
              }
            />
          </Routes>
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
