import { act, renderHook, waitFor } from '@testing-library/react';
import { Folder } from '../../../app/model';
import { createFixtureSkillGateway } from '../adapters/fixtureSkillGateway';
import { Skill } from '../model';
import { SkillGateway } from '../ports/SkillGateway';
import { useSkillsController } from './useSkillsController';

const infra: Folder = { uid: 'infra', title: 'Infra', permission: 'View', serviceCount: 1 };
const payment: Folder = { uid: 'payment', title: 'Payment', permission: 'Edit', serviceCount: 1 };

describe('useSkillsController', () => {
  test('ignores an old response published after Folder changes', async () => {
    const first = deferred<Skill[]>();
    const second = deferred<Skill[]>();
    const base = createFixtureSkillGateway({ latencyMs: 0 });
    const gateway: SkillGateway = {
      ...base,
      listSkills: jest.fn(({ folderUids }) => (folderUids[0] === 'infra' ? first.promise : second.promise)),
    };
    const { result, rerender } = renderHook(
      ({ folders }) => useSkillsController({ folders, gateway }),
      { initialProps: { folders: [infra] } }
    );

    await waitFor(() => expect(gateway.listSkills).toHaveBeenCalledWith({ folderUids: ['infra'] }, expect.any(AbortSignal)));
    rerender({ folders: [payment] });
    await waitFor(() => expect(gateway.listSkills).toHaveBeenCalledWith({ folderUids: ['payment'] }, expect.any(AbortSignal)));

    await act(async () => second.resolve([skill('new')]));
    await waitFor(() => expect(result.current.state).toMatchObject({ status: 'success', data: [{ id: 'new' }] }));
    await act(async () => first.resolve([skill('old')]));

    expect(result.current.state).toMatchObject({ status: 'success', data: [{ id: 'new' }] });
  });
});

function skill(id: string): Skill {
  return { id } as Skill;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
