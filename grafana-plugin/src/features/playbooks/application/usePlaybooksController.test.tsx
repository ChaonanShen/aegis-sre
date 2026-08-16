import { act, renderHook, waitFor } from '@testing-library/react';
import { PlaybookSummary } from '../crudModel';
import { PlaybookCrudGateway } from '../ports/PlaybookCrudGateway';
import { usePlaybooksController } from './usePlaybooksController';

describe('usePlaybooksController', () => {
  test('ignores a stale response after the gateway changes', async () => {
    const first = deferred<PlaybookSummary[]>();
    const second = deferred<PlaybookSummary[]>();
    const gateway = (promise: Promise<PlaybookSummary[]>): PlaybookCrudGateway => ({
      listPlaybooks: jest.fn(() => promise),
      getPlaybook: jest.fn(), createPlaybook: jest.fn(), updatePlaybook: jest.fn(),
      deletePlaybook: jest.fn(), validatePlaybook: jest.fn(),
      listRuns: jest.fn(), startRun: jest.fn(), getRun: jest.fn(), cancelRun: jest.fn(),
    });
    const oldGateway = gateway(first.promise);
    const newGateway = gateway(second.promise);
    const { result, rerender } = renderHook(({ current }) => usePlaybooksController({ gateway: current }), {
      initialProps: { current: oldGateway },
    });
    await waitFor(() => expect(oldGateway.listPlaybooks).toHaveBeenCalled());
    rerender({ current: newGateway });
    await waitFor(() => expect(newGateway.listPlaybooks).toHaveBeenCalled());
    await act(async () => second.resolve([summary('new')]));
    await waitFor(() => expect(result.current.state).toMatchObject({ status: 'success', data: [{ id: 'new' }] }));
    await act(async () => first.resolve([summary('old')]));
    expect(result.current.state).toMatchObject({ status: 'success', data: [{ id: 'new' }] });
  });
});

function summary(id: string): PlaybookSummary {
  return { id, folderUid: 'ops', name: id, description: '', status: 'active', readOnly: false };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
