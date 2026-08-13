import React, { useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createFixtureSkillGateway } from '../adapters/fixtureSkillGateway';
import { skillFixtureData } from '../fixtures/skillFixtures';
import { SkillRun } from '../model';
import { SkillGateway } from '../ports/SkillGateway';
import { SkillRunDialog } from './SkillRunDialog';

describe('SkillRunDialog', () => {
  test('focuses the modal and restores the opener after Escape', async () => {
    const base = createFixtureSkillGateway({ storageKey: 'skill-run-dialog-a11y' });
    const gateway: SkillGateway = { ...base, listRuns: jest.fn(async () => []) };

    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)} type="button">
            打开 Skill 运行
          </button>
          {open && (
            <SkillRunDialog
              canApprove
              gateway={gateway}
              onClose={() => setOpen(false)}
              skill={skillFixtureData.skills[0]}
            />
          )}
        </>
      );
    }

    render(<Harness />);
    const opener = screen.getByRole('button', { name: '打开 Skill 运行' });
    opener.focus();
    fireEvent.click(opener);

    const dialog = await screen.findByRole('dialog', { name: /运行 checkout-troubleshoot/ });
    expect(within(dialog).getByRole('button', { name: '关闭运行' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /运行 checkout-troubleshoot/ })).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  test('surfaces a synchronous start gateway error in the dialog', async () => {
    const base = createFixtureSkillGateway({ storageKey: 'skill-run-dialog-sync-error' });
    const gateway: SkillGateway = {
      ...base,
      listRuns: jest.fn(async () => []),
      startDryRun: jest.fn(() => {
        throw new Error('运行入口不可用。');
      }),
    };

    render(<SkillRunDialog canApprove gateway={gateway} onClose={() => undefined} skill={skillFixtureData.skills[0]} />);

    fireEvent.click(await screen.findByRole('button', { name: /开始预览/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('运行入口不可用。');
  });

  test('does not approve a View-only interrupt through a direct handler call', async () => {
    const base = createFixtureSkillGateway({ storageKey: 'skill-run-dialog-view-only' });
    const run = waitingRun();
    const resolveRun = jest.fn(() => {
      throw new Error('should not be called');
    });
    const gateway: SkillGateway = {
      ...base,
      listRuns: jest.fn(async () => [run]),
      resolveRun,
    };

    render(<SkillRunDialog canApprove={false} gateway={gateway} onClose={() => undefined} skill={skillFixtureData.skills[0]} />);

    const approve = await screen.findByRole('button', { name: '批准模拟执行' });
    expect(approve).toBeDisabled();
    fireEvent.click(approve);
    expect(resolveRun).not.toHaveBeenCalled();
  });

  test('allows only one cancellation while the gateway request is pending', async () => {
    const base = createFixtureSkillGateway({ storageKey: 'skill-run-dialog-cancel-flight' });
    const run = runningRun();
    let resolveCancel: (value: SkillRun) => void = () => undefined;
    const cancelPromise = new Promise<SkillRun>((resolve) => {
      resolveCancel = resolve;
    });
    const cancelRun = jest.fn(() => cancelPromise);
    const gateway: SkillGateway = {
      ...base,
      listRuns: jest.fn(async () => [run]),
      cancelRun,
    };

    render(<SkillRunDialog canApprove gateway={gateway} onClose={() => undefined} skill={skillFixtureData.skills[0]} />);

    const cancel = await screen.findByRole('button', { name: '取消' });
    fireEvent.click(cancel);
    fireEvent.click(cancel);
    expect(cancelRun).toHaveBeenCalledTimes(1);
    expect(cancel).toBeDisabled();

    resolveCancel({ ...run, status: 'cancelled' });
    await waitFor(() => expect(screen.getByText('cancelled', { selector: '.skill-run-status' })).toBeInTheDocument());
  });
});

function runningRun(): SkillRun {
  return {
    id: 'skill-run-running',
    skillId: 'sk-001',
    status: 'running',
    dryRun: true,
    params: {},
    toolCalls: [],
    initiatedBy: 'alice',
    startedAt: '2026-07-25T08:00:00.000Z',
    updatedAt: '2026-07-25T08:00:01.000Z',
  };
}

function waitingRun(): SkillRun {
  return {
    ...runningRun(),
    id: 'skill-run-waiting',
    status: 'waiting_for_approval',
    pendingInterrupt: {
      callId: 'call-1',
      tool: 'grafana_mcp/update_dashboard',
      preview: ['dry_run: true'],
    },
  };
}
