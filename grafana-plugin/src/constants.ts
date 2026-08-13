import pluginJson from './plugin.json';

export const PLUGIN_BASE_URL = `/a/${pluginJson.id}`;

// Plugin Resource API 由 Grafana 转发给同一插件的 Go Backend。
// 浏览器只访问 Grafana，不直接访问 AI Core，也不接触服务间配置。
export const PLUGIN_RESOURCE_BASE_URL = `/api/plugins/${pluginJson.id}/resources`;

export enum ROUTES {
  Workbench = 'workbench',
  Knowledge = 'knowledge',
  Playbooks = 'playbooks',
  Skills = 'skills',
  Approvals = 'approvals',
  Alerts = 'alerts',
  Audit = 'audit',
}
