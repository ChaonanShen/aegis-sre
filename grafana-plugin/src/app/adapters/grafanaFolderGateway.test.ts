import { BackendSrv, FetchResponse } from '@grafana/runtime';
import { of, throwError } from 'rxjs';
import { createGrafanaFolderGateway } from './grafanaFolderGateway';

describe('Grafana folder gateway', () => {
  test('lists only folders with generic Aegis actions and maps the highest permission', async () => {
    const backend = {
      fetch: jest.fn(() =>
        of(
          response([
            {
              uid: 'ops',
              title: 'Operations',
              type: 'dash-folder',
              accessControl: {
                'grafana-plugin-app.folder-resources:read': true,
                'grafana-plugin-app.folder-resources:write': true,
                'grafana-plugin-app.folder-resources:admin': true,
              },
            },
            {
              uid: 'apps',
              title: 'Applications',
              type: 'dash-folder',
              accessControl: {
                'grafana-plugin-app.folder-resources:read': true,
                'grafana-plugin-app.folder-resources:write': true,
              },
            },
            {
              uid: 'readonly',
              title: 'Read only',
              type: 'dash-folder',
              accessControl: { 'grafana-plugin-app.folder-resources:read': true },
            },
            { uid: 'hidden', title: 'No Aegis permission', type: 'dash-folder' },
          ])
        )
      ),
    } as unknown as BackendSrv;

    await expect(createGrafanaFolderGateway(backend).listFolders()).resolves.toEqual([
      { uid: 'ops', title: 'Operations', permission: 'Admin', serviceCount: 0 },
      { uid: 'apps', title: 'Applications', permission: 'Edit', serviceCount: 0 },
      { uid: 'readonly', title: 'Read only', permission: 'View', serviceCount: 0 },
    ]);
    expect(backend.fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: '/api/search',
        params: { type: 'dash-folder', limit: 1000 },
        showErrorAlert: false,
      })
    );
  });

  test('rejects invalid search data instead of inventing folders', async () => {
    const backend = { fetch: jest.fn(() => of(response([{ uid: 'ops', title: 42 }]))) } as unknown as BackendSrv;
    await expect(createGrafanaFolderGateway(backend).listFolders()).rejects.toThrow('无效 Folder');
  });

  test('preserves cancellation as AbortError', async () => {
    const backend = {
      fetch: jest.fn(() => throwError(() => ({ cancelled: true, status: 0, data: undefined }))),
    } as unknown as BackendSrv;
    await expect(createGrafanaFolderGateway(backend).listFolders()).rejects.toMatchObject({ name: 'AbortError' });
  });
});

function response<T>(data: T): FetchResponse<T> {
  return {
    data,
    status: 200,
    statusText: 'OK',
    ok: true,
    headers: new Headers(),
    config: { url: '' },
  } as FetchResponse<T>;
}
