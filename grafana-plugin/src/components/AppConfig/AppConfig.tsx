import React from 'react';
import { AppPluginMeta, PluginConfigPageProps } from '@grafana/data';
import { FieldSet } from '@grafana/ui';

export type AppConfigProps = PluginConfigPageProps<AppPluginMeta<Record<string, never>>>;

const AppConfig = (_: AppConfigProps) => (
  <FieldSet label="AI 服务连接">
    <p>
      AI Core 地址由 Grafana 服务端通过 TORCHBEARING_AI_CORE_URL 配置。浏览器端不保存上游地址、身份信息或凭据。
    </p>
  </FieldSet>
);

export default AppConfig;
