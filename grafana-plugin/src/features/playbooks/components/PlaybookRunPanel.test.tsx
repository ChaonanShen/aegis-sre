import React, { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createFixturePlaybookGateway } from '../adapters/fixturePlaybookGateway';
import { playbookFixtureData } from '../fixtures/playbookFixtures';
import { PlaybookGateway } from '../ports/PlaybookGateway';
import { PlaybookRun } from '../model';
import { PlaybookRunPanel } from './PlaybookRunPanel';

describe('PlaybookRunPanel', () => {
  test('focuses the setup form and restores the opener after Escape', async () => {
    const base = createFixturePlaybookGateway({ latencyMs: 0, storageKey: 'playbook-run-panel-a11y' });
    const gateway: PlaybookGateway = { ...base, listRuns: jest.fn(async () => []) };

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)} type="button">
            打开运行设置
          </button>
          <PlaybookRunPanel
            canApprove
            gateway={gateway}
            onSetupClose={() => setOpen(false)}
            playbook={playbookFixtureData.playbooks[0]}
            setupOpen={open}
          />
        </>
      );
    }

    render(<Harness />);
    const opener = screen.getByRole('button', { name: '打开运行设置' });
    opener.focus();
    fireEvent.click(opener);

    const dialog = await screen.findByRole('dialog', { name: /运行 checkout-latency-investigation/ });
    expect(screen.getByRole('textbox', { name: 'Run parameter env' })).toHaveFocus();

    const start = within(dialog).getByRole('button', { name: /开始预览/ });
    start.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(within(dialog).getByRole('button', { name: '关闭运行设置' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /运行 checkout-latency-investigation/ })).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  test('surfaces a synchronous retry gateway error in the UI', async () => {
    const base = createFixturePlaybookGateway({ latencyMs: 0, storageKey: 'playbook-run-panel-sync-error' });
    const failedRun: PlaybookRun = {
      id: 'run-expired',
      playbookId: 'pb-001',
      status: 'failed',
      dryRun: true,
      params: { env: 'production' },
      steps: [],
      initiatedBy: 'alice',
      startedAt: '2026-07-25T08:00:00.000Z',
      updatedAt: '2026-07-25T08:00:01.000Z',
      endedAt: '2026-07-25T08:00:01.000Z',
    };
    const gateway: PlaybookGateway = {
      ...base,
      listRuns: jest.fn(async () => [failedRun]),
      retryRun: jest.fn(() => {
        throw new Error('Run 已过期。');
      }),
    };

    render(
      <PlaybookRunPanel
        canApprove
        gateway={gateway}
        onSetupClose={() => undefined}
        playbook={playbookFixtureData.playbooks[0]}
        setupOpen={false}
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Run 已过期。'));
    expect(gateway.retryRun).toHaveBeenCalledWith('run-expired', expect.any(AbortSignal));
  });

  test('allows only one cancellation while the gateway request is pending', async () => {
    const base = createFixturePlaybookGateway({ latencyMs: 0, storageKey: 'playbook-run-panel-cancel-flight' });
    const run = runningRun();
    let resolveCancel: (value: PlaybookRun) => void = () => undefined;
    const cancelPromise = new Promise<PlaybookRun>((resolve) => {
      resolveCancel = resolve;
    });
    const cancelRun = jest.fn(() => cancelPromise);
    const gateway: PlaybookGateway = {
      ...base,
      listRuns: jest.fn(async () => [run]),
      cancelRun,
    };

    render(
      <PlaybookRunPanel
        canApprove
        gateway={gateway}
        onSetupClose={() => undefined}
        playbook={playbookFixtureData.playbooks[0]}
        setupOpen={false}
      />
    );

    const cancel = await screen.findByRole('button', { name: /取消运行/ });
    fireEvent.click(cancel);
    fireEvent.click(cancel);
    expect(cancelRun).toHaveBeenCalledTimes(1);
    expect(cancel).toBeDisabled();

    resolveCancel({ ...run, status: 'cancelled' });
    await waitFor(() => expect(screen.getByText('cancelled', { selector: '.playbook-run-status' })).toBeInTheDocument());
  });
});

function runningRun(): PlaybookRun {
  return {
    id: 'run-running',
    playbookId: 'pb-001',
    status: 'running',
    dryRun: true,
    params: { env: 'production' },
    steps: [],
    initiatedBy: 'alice',
    startedAt: '2026-07-25T08:00:00.000Z',
    updatedAt: '2026-07-25T08:00:01.000Z',
  };
}
