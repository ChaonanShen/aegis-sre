import { BackendSrv, BackendSrvRequest, getBackendSrv, isFetchError } from '@grafana/runtime';
import { lastValueFrom } from 'rxjs';
import type { components } from '../../api/generated/controlPlane';
import { PLUGIN_RESOURCE_BASE_URL } from '../../constants';

export type ResourceDataGuard<T> = (value: unknown) => value is T;

export interface ResourceRequestOptions {
  method?: string;
  data?: unknown;
  params?: BackendSrvRequest['params'];
  signal?: AbortSignal;
  headers?: BackendSrvRequest['headers'];
}

type Problem = components['schemas']['Problem'];

/** ResourceClientError 同时保留 HTTP 状态和公共业务码。 */
export class ResourceClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | number,
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
      headers: options.headers,
      showErrorAlert: false,
      validatePath: true,
    };

    try {
      const response = await lastValueFrom(this.backendSrv.fetch<unknown>(request));
      return validateData(response.data, response.status, guard);
    } catch (error) {
      if (error instanceof ResourceClientError) {
        throw error;
      }
      if (isFetchError<unknown>(error)) {
        if (error.cancelled) {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
        const problem = error.data;
        if (isProblem(problem)) {
          throw new ResourceClientError(error.status, problem.code, problem.detail || problem.title || '请求失败。');
        }
        throw new ResourceClientError(error.status, 0, error.message || error.statusText || '请求失败。');
      }
      throw error;
    }
  }

  async requestVoid(path: string, options: ResourceRequestOptions = {}): Promise<void> {
    const request: BackendSrvRequest = {
      url: resourceURL(path),
      method: options.method ?? 'DELETE',
      data: options.data,
      params: options.params,
      abortSignal: options.signal,
      headers: options.headers,
      showErrorAlert: false,
      validatePath: true,
    };
    try {
      await lastValueFrom(this.backendSrv.fetch(request));
    } catch (error) {
      if (isFetchError<unknown>(error)) {
        if (error.cancelled) {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
        if (isProblem(error.data)) {
          throw new ResourceClientError(error.status, error.data.code, error.data.detail || error.data.title);
        }
      }
      throw error;
    }
  }

  async requestBlob(path: string, options: ResourceRequestOptions = {}): Promise<Blob> {
    const request: BackendSrvRequest = {
      url: resourceURL(path),
      method: options.method ?? 'GET',
      abortSignal: options.signal,
      headers: options.headers,
      responseType: 'blob',
      showErrorAlert: false,
      validatePath: true,
    };
    try {
      const response = await lastValueFrom(this.backendSrv.fetch<Blob>(request));
      if (!(response.data instanceof Blob)) {
        throw new ResourceClientError(response.status, 0, 'Plugin Backend 返回了无效文件。');
      }
      return response.data;
    } catch (error) {
      if (error instanceof ResourceClientError) {
        throw error;
      }
      if (isFetchError<unknown>(error)) {
        if (error.cancelled) {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
        if (isProblem(error.data)) {
          throw new ResourceClientError(error.status, error.data.code, error.data.detail || error.data.title);
        }
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

function validateData<T>(data: unknown, status: number, guard: ResourceDataGuard<T>): T {
  if (!guard(data)) {
    throw new ResourceClientError(status, 0, 'Plugin Backend 返回了无效业务数据。');
  }
  return data;
}

function isProblem(value: unknown): value is Problem {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    typeof value.status === 'number' &&
    'code' in value &&
    typeof value.code === 'string' &&
    'title' in value &&
    typeof value.title === 'string' &&
    'request_id' in value &&
    typeof value.request_id === 'string' &&
    'trace_id' in value &&
    typeof value.trace_id === 'string'
  );
}
