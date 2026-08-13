import React, { Suspense } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { AppRootProps, PluginType } from '@grafana/data';
import { render, screen } from '@testing-library/react';
import { PRODUCT_BRAND } from '../../app/brand';
import App from './App';

jest.mock('@grafana/runtime', () => ({
  PluginPage: ({ children }: React.PropsWithChildren) => <>{children}</>,
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

  test('hides fixture-backed pages in real mode', async () => {
    render(
      <MemoryRouter initialEntries={['/knowledge']}>
        <Suspense fallback={null}>
          <App {...props} />
        </Suspense>
      </MemoryRouter>
    );

    expect(await screen.findByTestId('feature-pending')).toBeInTheDocument();
    expect(screen.getByText('真实模式尚未接通，演示数据已隐藏。')).toBeInTheDocument();
  });
});
