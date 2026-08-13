import React from 'react';
import { render, screen } from '@testing-library/react';
import { PluginType } from '@grafana/data';
import AppConfig, { AppConfigProps } from './AppConfig';

describe('Components/AppConfig', () => {
  test('only describes server-managed AI service configuration', () => {
    const props = {
      plugin: {
        meta: {
          id: 'sample-app',
          name: 'Sample App',
          type: PluginType.app,
          enabled: true,
          jsonData: {},
        },
      },
      query: {},
    } as unknown as AppConfigProps;

    render(<AppConfig {...props} />);

    expect(screen.getByRole('group', { name: /AI 服务连接/i })).toBeInTheDocument();
    expect(screen.getByText(/AEGIS_CONTROL_PLANE_URL/)).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText(/datasource uid allowlist|grant 私钥|agent 地址/i)).not.toBeInTheDocument();
  });
});
