import { act, renderHook, waitFor } from '@testing-library/react';
import { Folder } from '../../../app/model';
import { createFixturePlaybookGateway } from '../adapters/fixturePlaybookGateway';
import { Playbook } from '../model';
import { PlaybookGateway } from '../ports/PlaybookGateway';
import { usePlaybooksController } from './usePlaybooksController';

const infra: Folder = { uid: 'infra', title: 'Infra', permission: 'View', serviceCount: 1 };
const payment: Folder = { uid: 'payment', title: 'Payment', permission: 'Edit', serviceCount: 1 };

describe('usePlaybooksController', () => {
  test('ignores an old response published after Folder changes', async () => {
    const first = deferred<Playbook[]>();
    const second = deferred<Playbook[]>();
    const base = createFixturePlaybookGateway({ latencyMs: 0 });
    const gateway: PlaybookGateway = {
      ...base,
      listPlaybooks: jest.fn(({ folderUids }) => (folderUids[0] === 'infra' ? first.promise : second.promise)),
    };
    const { result, rerender } = renderHook(
      ({ folders }) => usePlaybooksController({ folders, gateway }),
      { initialProps: { folders: [infra] } }
    );

    await waitFor(() =>
      expect(gateway.listPlaybooks).toHaveBeenCalledWith({ folderUids: ['infra'] }, expect.any(AbortSignal))
    );
    rerender({ folders: [payment] });
    await waitFor(() =>
      expect(gateway.listPlaybooks).toHaveBeenCalledWith({ folderUids: ['payment'] }, expect.any(AbortSignal))
    );

    await act(async () => second.resolve([playbook('new')]));
    await waitFor(() => expect(result.current.state).toMatchObject({ status: 'success', data: [{ id: 'new' }] }));
    await act(async () => first.resolve([playbook('old')]));

    expect(result.current.state).toMatchObject({ status: 'success', data: [{ id: 'new' }] });
  });
});

function playbook(id: string): Playbook {
  return { id } as Playbook;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
