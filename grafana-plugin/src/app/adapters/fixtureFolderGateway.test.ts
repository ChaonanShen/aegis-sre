import { createFixtureFolderGateway } from './fixtureFolderGateway';

describe('createFixtureFolderGateway', () => {
  test('returns isolated fixture folder copies', async () => {
    const gateway = createFixtureFolderGateway({ latencyMs: 0 });
    const first = await gateway.listFolders();
    const second = await gateway.listFolders();

    expect(first.map(({ uid }) => uid)).toEqual(['shared', 'payment', 'search', 'infra', 'biz']);
    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(second[0]);
  });

  test('honors an already-aborted request', async () => {
    const gateway = createFixtureFolderGateway({ latencyMs: 0 });
    const controller = new AbortController();
    controller.abort();

    await expect(gateway.listFolders(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
