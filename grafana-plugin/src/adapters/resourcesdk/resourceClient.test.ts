import { BackendSrv, BackendSrvRequest, FetchResponse } from '@grafana/runtime';
import { of, throwError } from 'rxjs';
import { ResourceClient, ResourceClientError } from './resourceClient';

const validPayload = { value: 'ok' };
const isPayload = (value: unknown): value is typeof validPayload =>
  typeof value === 'object' && value !== null && 'value' in value && value.value === 'ok';

describe('ResourceClient', () => {
  test('calls the current plugin Resource API and validates direct data', async () => {
    const fetch = jest.fn(() => of(response(validPayload)));
    const client = new ResourceClient({ fetch } as unknown as BackendSrv);

    await expect(client.request('/api/v1/sessions', isPayload)).resolves.toEqual(validPayload);

    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: '/api/plugins/grafana-plugin-app/resources/api/v1/sessions',
        method: 'GET',
        showErrorAlert: false,
        validatePath: true,
      })
    );
  });

  test('rejects a successful response with invalid business data', async () => {
    const fetch = jest.fn(() => of(response({ unexpected: true })));
    const client = new ResourceClient({ fetch } as unknown as BackendSrv);

    await expect(client.request('/api/v1/sessions', isPayload)).rejects.toMatchObject({
      status: 200,
      code: 0,
      message: 'Plugin Backend 返回了无效业务数据。',
    });
  });

  test('preserves HTTP status and business code from failed Resource responses', async () => {
    const fetch = jest.fn(() =>
      throwError(() => ({
        status: 403,
        statusText: 'Forbidden',
        data: {
          type: 'about:blank', title: 'Forbidden', status: 403, code: 'forbidden', detail: 'folder denied',
          request_id: 'req-1', trace_id: 'trace-1', retryable: false,
        },
        config: {} as BackendSrvRequest,
      }))
    );
    const client = new ResourceClient({ fetch } as unknown as BackendSrv);

    await expect(client.request('/api/v1/sessions', isPayload)).rejects.toEqual(
      new ResourceClientError(403, 'forbidden', 'folder denied')
    );
  });

  test('preserves the AbortError contract for cancelled Grafana requests', async () => {
    const fetch = jest.fn(() =>
      throwError(() => ({
        status: 0,
        statusText: 'Cancelled',
        data: undefined,
        cancelled: true,
        config: {} as BackendSrvRequest,
      }))
    );
    const client = new ResourceClient({ fetch } as unknown as BackendSrv);

    await expect(client.request('/api/v1/sessions', isPayload)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  test('rejects paths outside the public API prefix before sending a request', async () => {
    const fetch = jest.fn();
    const client = new ResourceClient({ fetch } as unknown as BackendSrv);

    await expect(client.request('/private/services', isPayload)).rejects.toMatchObject({
      status: 0,
      message: 'Resource 路径必须位于 /api/v1 下。',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

function response<T>(data: T): FetchResponse<T> {
  return {
    data,
    status: 200,
    statusText: 'OK',
    ok: true,
    headers: new Headers(),
    redirected: false,
    type: 'basic',
    url: '',
    config: { url: '' },
  };
}
