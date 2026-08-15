import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PlaybookRunRecord } from '../crudModel';
import { PlaybookCrudGateway } from '../ports/PlaybookCrudGateway';
import { PlaybookRunsPanel } from './PlaybookRunsPanel';

describe('PlaybookRunsPanel', () => {
  test('allows another run after history exists and reflects the streamed terminal snapshot', async () => {
    const historic = run('run_history', 'succeeded');
    const queued = run('run_new', 'queued');
    const succeeded = run('run_new', 'succeeded');
    const gateway = fakeGateway([historic]);
    gateway.startRun.mockResolvedValue(queued);
    gateway.streamRun = jest.fn(() => stream(succeeded));

    render(<PlaybookRunsPanel gateway={gateway} playbookId="pbk_scope_abcdefgh" />);

    fireEvent.click(await screen.findByRole('button', { name: '运行 Playbook' }));
    await waitFor(() => expect(gateway.startRun).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getAllByText('成功')).toHaveLength(2));
    expect(screen.getByRole('button', { name: '运行 Playbook' })).toBeEnabled();
  });
});

function run(id: string, status: PlaybookRunRecord['status']): PlaybookRunRecord {
  return {
    id,
    playbookId: 'pbk_scope_abcdefgh',
    status,
    startedAt: '2026-08-14T10:00:00Z',
    updatedAt: '2026-08-14T10:00:01Z',
    steps: [],
  };
}

async function* stream(value: PlaybookRunRecord): AsyncGenerator<PlaybookRunRecord> {
  yield value;
}

function fakeGateway(runs: PlaybookRunRecord[]): jest.Mocked<PlaybookCrudGateway> {
  return {
    listPlaybooks: jest.fn(), getPlaybook: jest.fn(), createPlaybook: jest.fn(), updatePlaybook: jest.fn(),
    deletePlaybook: jest.fn(), validatePlaybook: jest.fn(),
    listRuns: jest.fn(async (_playbookId: string, _signal?: AbortSignal) => runs),
    startRun: jest.fn(), getRun: jest.fn(), cancelRun: jest.fn(), retryRun: jest.fn(),
  };
}
