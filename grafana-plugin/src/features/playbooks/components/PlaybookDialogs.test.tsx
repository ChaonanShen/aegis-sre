import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { createFixturePlaybookGateway } from '../adapters/fixturePlaybookGateway';
import { createFixtureWorkbenchGateway } from '../../workbench/adapters/fixtureWorkbenchGateway';
import { SessionSummary } from '../../workbench/model';
import { WorkbenchGateway } from '../../workbench/ports/WorkbenchGateway';
import { ConversationDraftDialog } from './PlaybookDialogs';

describe('ConversationDraftDialog', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  test('ignores a stale session list when the Workbench gateway changes', async () => {
    const first = deferred<SessionSummary[]>();
    const second = deferred<SessionSummary[]>();
    const base = createFixtureWorkbenchGateway({ latencyMs: 0 });
    let call = 0;
    const listSessions = jest.fn((signal?: AbortSignal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      call += 1;
      return call === 1 ? first.promise : second.promise;
    });
    const firstGateway: WorkbenchGateway = { ...base, listSessions };
    const secondGateway: WorkbenchGateway = { ...base, listSessions };
    const playbookGateway = createFixturePlaybookGateway({ latencyMs: 0 });
    const view = (workbenchGateway: WorkbenchGateway) => (
      <MemoryRouter>
        <ConversationDraftDialog
          onClose={jest.fn()}
          playbookGateway={playbookGateway}
          workbenchGateway={workbenchGateway}
        />
      </MemoryRouter>
    );

    const { rerender } = render(view(firstGateway));
    await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(1));

    rerender(view(secondGateway));
    await waitFor(() => expect(listSessions).toHaveBeenCalledTimes(2));

    await act(async () => second.resolve([summary('new-session')]));
    expect(await screen.findByRole('option', { name: /new-session/ })).toBeInTheDocument();

    await act(async () => first.resolve([summary('stale-session')]));
    expect(screen.queryByRole('option', { name: /stale-session/ })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: /new-session/ })).toBeInTheDocument();
  });

  test('closes the conversation dialog with Escape', () => {
    const onClose = jest.fn();
    const playbookGateway = createFixturePlaybookGateway({ latencyMs: 0 });
    const workbenchGateway = createFixtureWorkbenchGateway({ latencyMs: 0 });
    render(
      <MemoryRouter>
        <ConversationDraftDialog
          onClose={onClose}
          playbookGateway={playbookGateway}
          workbenchGateway={workbenchGateway}
        />
      </MemoryRouter>
    );

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

function summary(id: string): SessionSummary {
  return {
    id,
    title: id,
    folderUid: 'payment',
    folderTitle: 'Payment',
    status: 'active',
    visibility: 'private',
    updatedAt: '2026-07-25T00:00:00.000Z',
    messageCount: 0,
    preview: '',
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
