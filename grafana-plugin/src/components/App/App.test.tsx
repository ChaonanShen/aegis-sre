import React, { Suspense } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { AppRootProps, PluginType } from '@grafana/data';
import { render, screen } from '@testing-library/react';
import { of } from 'rxjs';
import { PRODUCT_BRAND } from '../../app/brand';
import App from './App';

jest.mock('@grafana/runtime', () => ({
  PluginPage: ({ children }: React.PropsWithChildren) => <>{children}</>,
  getBackendSrv: () => ({
    fetch: jest.fn((request: { url: string }) =>
      of({
        data:
          request.url === '/api/search'
            ? [
                {
                  uid: 'ops',
                  title: 'Operations',
                  type: 'dash-folder',
                  accessControl: { 'grafana-plugin-app.folder-resources:read': true },
                },
              ]
            : request.url === '/api/access-control/user/permissions'
              ? { 'grafana-plugin-app.folder-resources:read': ['folders:uid:ops'] }
              : request.url.includes('/api/v1/capabilities')
                ? { items: [{ name: 'knowledge', status: 'available' }] }
              : { items: [], has_more: false },
        status: 200,
        headers: new Headers(),
        config: request,
      })
    ),
  }),
  isFetchError: () => false,
}));

describe('Components/App', () => {
  let props: AppRootProps;

  beforeEach(() => {
    jest.resetAllMocks();

    props = {
      basename: 'a/sample-app',
      meta: {
        id: 'sample-app',
        name: 'Sample App',
        type: PluginType.app,
        enabled: true,
        jsonData: {},
      },
      query: {},
      path: '',
      onNavChanged: jest.fn(),
    } as unknown as AppRootProps;
  });

  test('renders without an error', async () => {
    render(
      <MemoryRouter>
        <Suspense fallback={null}>
          <App {...props} />
        </Suspense>
      </MemoryRouter>
    );

    // The production entry point also renders lazy routes inside a Suspense boundary.
    expect(await screen.findByTestId('torchbearing-app')).toBeInTheDocument();
    expect(screen.getByText(PRODUCT_BRAND.tagline)).toBeInTheDocument();
  });

  test('mounts the real Knowledge page without fixture records', async () => {
    render(
      <MemoryRouter initialEntries={['/knowledge']}>
        <Suspense fallback={null}>
          <App {...props} />
        </Suspense>
      </MemoryRouter>
    );

    expect(await screen.findByText('此 Folder 尚无知识库。')).toBeInTheDocument();
    expect(screen.getByText('创建或选择一个知识库后开始管理文档。')).toBeInTheDocument();
    expect(screen.queryByTestId('feature-pending')).not.toBeInTheDocument();
  });
});
