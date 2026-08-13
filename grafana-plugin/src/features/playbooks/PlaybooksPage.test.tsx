import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppServicesProvider } from '../../app/AppServices';
import { AppShellProvider } from '../../app/AppShellContext';
import { PlaybookDocument } from './crudModel';
import { PlaybookCrudGateway } from './ports/PlaybookCrudGateway';
import PlaybooksPage from './PlaybooksPage';

const firstSource = `name: diagnose-api
description: Diagnose API
steps:
  - id: metrics
    action: mcp.call
    with: {server: grafana-read, tool: query_prometheus}
`;

describe('PlaybooksPage native Dagu CRUD', () => {
  test('lists summaries without loading every source', async () => {
    const gateway = fakeGateway();
    renderPage('/a/grafana-plugin-app/playbooks', gateway);
    expect(await screen.findByText('diagnose-api')).toBeInTheDocument();
    expect(gateway.listPlaybooks).toHaveBeenCalledTimes(1);
    expect(gateway.getPlaybook).not.toHaveBeenCalled();
  });

  test('loads a deep-linked detail directly and renders DAG and YAML', async () => {
    const gateway = fakeGateway();
    renderPage('/a/grafana-plugin-app/playbooks/pbk_scope_abcdefgh', gateway);
    expect(await screen.findByText('diagnose-api', { selector: 'code' })).toBeInTheDocument();
    expect(gateway.listPlaybooks).not.toHaveBeenCalled();
    expect(gateway.getPlaybook).toHaveBeenCalledWith('pbk_scope_abcdefgh', expect.any(AbortSignal));
    expect(within(screen.getByRole('img', { name: 'Playbook DAG' })).getAllByText('metrics')).toHaveLength(2);
    fireEvent.click(screen.getByRole('tab', { name: 'YAML 源码' }));
    expect(screen.getByLabelText('Playbook YAML')).toHaveTextContent('action: mcp.call');
  });

  test('creates from native YAML after server validation and keeps one operation key', async () => {
    const gateway = fakeGateway();
    renderPage('/a/grafana-plugin-app/playbooks/new', gateway);
    const editor = screen.getByRole('textbox', { name: 'Playbook YAML 编辑器' });
    fireEvent.change(editor, { target: { value: firstSource } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(gateway.createPlaybook).toHaveBeenCalledTimes(1));
    expect(gateway.validatePlaybook).toHaveBeenCalledWith(firstSource, expect.any(AbortSignal));
    expect(gateway.createPlaybook).toHaveBeenCalledWith(
      { source: firstSource, idempotencyKey: expect.stringMatching(/^playbook-/) },
      expect.any(AbortSignal)
    );
  });

  test('shows Dagu validation errors and does not create', async () => {
    const gateway = fakeGateway();
    gateway.validatePlaybook = jest.fn(async (_source: string, _signal?: AbortSignal) => ({ valid: false, errors: [{ path: 'steps[0]', message: 'action is required' }] }));
    renderPage('/a/grafana-plugin-app/playbooks/new', gateway);
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('steps[0]: action is required');
    expect(gateway.createPlaybook).not.toHaveBeenCalled();
  });

  test('edits by GET and PUT without loading the list', async () => {
    const gateway = fakeGateway();
    renderPage('/a/grafana-plugin-app/playbooks/pbk_scope_abcdefgh/edit', gateway);
    const editor = await screen.findByRole('textbox', { name: 'Playbook YAML 编辑器' });
    const updated = firstSource.replace('Diagnose API', 'Diagnose API safely');
    fireEvent.change(editor, { target: { value: updated } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(gateway.updatePlaybook).toHaveBeenCalledWith(
      'pbk_scope_abcdefgh', { source: updated }, expect.any(AbortSignal)
    ));
    expect(gateway.listPlaybooks).not.toHaveBeenCalled();
  });

  test('deletes only the definition and returns to the list', async () => {
    jest.spyOn(window, 'confirm').mockReturnValue(true);
    const gateway = fakeGateway();
    renderPage('/a/grafana-plugin-app/playbooks/pbk_scope_abcdefgh', gateway);
    fireEvent.click(await screen.findByRole('button', { name: '删除' }));
    await waitFor(() => expect(gateway.deletePlaybook).toHaveBeenCalledWith('pbk_scope_abcdefgh'));
  });
});

function document(source = firstSource): PlaybookDocument {
  return { id: 'pbk_scope_abcdefgh', name: 'diagnose-api', description: 'Diagnose API', status: 'active', source };
}

function fakeGateway(): jest.Mocked<PlaybookCrudGateway> {
  return {
    listPlaybooks: jest.fn(async () => [document()]),
    getPlaybook: jest.fn(async (_id: string, _signal?: AbortSignal) => document()),
    createPlaybook: jest.fn(async ({ source }) => document(source)),
    updatePlaybook: jest.fn(async (_id, { source }) => document(source)),
    deletePlaybook: jest.fn(async (_id: string, _signal?: AbortSignal) => undefined),
    validatePlaybook: jest.fn(async (_source: string, _signal?: AbortSignal) => ({ valid: true, errors: [] })),
    listRuns: jest.fn(async (_playbookId: string, _signal?: AbortSignal) => []),
    startRun: jest.fn(),
    getRun: jest.fn(),
    cancelRun: jest.fn(),
  };
}

function renderPage(initialEntry: string, gateway: PlaybookCrudGateway) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AppServicesProvider services={{ playbookGateway: gateway }}>
        <AppShellProvider>
          <Routes>
            <Route element={<PlaybooksPage />} path="/a/grafana-plugin-app/playbooks" />
            <Route element={<PlaybooksPage />} path="/a/grafana-plugin-app/playbooks/*" />
          </Routes>
        </AppShellProvider>
      </AppServicesProvider>
    </MemoryRouter>
  );
}
