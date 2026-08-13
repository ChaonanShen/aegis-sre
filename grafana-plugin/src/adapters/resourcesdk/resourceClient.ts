import { BackendSrv, BackendSrvRequest, getBackendSrv, isFetchError } from '@grafana/runtime';
import { lastValueFrom } from 'rxjs';
import { isResponse, Response as ResourceResponse } from '../../api/generated/pluginBackend';
import { PLUGIN_RESOURCE_BASE_URL } from '../../constants';

export type ResourceDataGuard<T> = (value: unknown) => value is T;

export interface ResourceRequestOptions {
  method?: string;
  data?: unknown;
  params?: BackendSrvRequest['params'];
  signal?: AbortSignal;
}

/** ResourceClientError 同时保留 HTTP 状态和公共业务码。 */
export class ResourceClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: number,
    message: string
  ) {
    super(message);
    this.name = 'ResourceClientError';
  }
}

/**
 * ResourceClient 统一处理 Grafana Resource URL、公共响应信封和传输错误。
 * 业务 adapter 仍须使用生成的 guard 校验 data，不能在这里猜测 DTO。
 */
export class ResourceClient {
  constructor(private readonly backendSrv: BackendSrv = getBackendSrv()) {}

  async request<T>(path: string, guard: ResourceDataGuard<T>, options: ResourceRequestOptions = {}): Promise<T> {
    const request: BackendSrvRequest = {
      url: resourceURL(path),
      method: options.method ?? 'GET',
      data: options.data,
      params: options.params,
      abortSignal: options.signal,
      showErrorAlert: false,
      validatePath: true,
    };

    try {
      const response = await lastValueFrom(this.backendSrv.fetch<ResourceResponse>(request));
      return unwrap(response.data, response.status, guard);
    } catch (error) {
      if (error instanceof ResourceClientError) {
        throw error;
      }
      if (isFetchError<unknown>(error)) {
        if (error.cancelled) {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
        const envelope = error.data;
        if (isResponse(envelope)) {
          throw new ResourceClientError(error.status, envelope.code, envelope.message || '请求失败。');
        }
        throw new ResourceClientError(error.status, 0, error.message || error.statusText || '请求失败。');
      }
      throw error;
    }
  }
}

function resourceURL(path: string): string {
  if (!path.startsWith('/api/v1/')) {
    throw new ResourceClientError(0, 0, 'Resource 路径必须位于 /api/v1 下。');
  }
  return `${PLUGIN_RESOURCE_BASE_URL}${path}`;
}

function unwrap<T>(envelope: unknown, status: number, guard: ResourceDataGuard<T>): T {
  if (!isResponse(envelope)) {
    throw new ResourceClientError(status, 0, 'Plugin Backend 返回了无效响应信封。');
  }
  if (envelope.code !== 0) {
    throw new ResourceClientError(status, envelope.code, envelope.message || '请求失败。');
  }
  if (!guard(envelope.data)) {
    throw new ResourceClientError(status, 0, 'Plugin Backend 返回了无效业务数据。');
  }
  return envelope.data;
}
