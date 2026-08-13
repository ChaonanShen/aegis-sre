# Grafana Plugin 迁移记录

## 迁移来源

- 来源仓库：`/Users/a1111/proj/Torchbearing-architecture`
- 来源目录：`grafana-plugin-app/`
- 来源提交：`d1fb7951a5648dcd4442948315f58cded25aae61`
- 迁移日期：2026-08-13
- 目标目录：`/Users/a1111/proj/aegis-sre/grafana-plugin`

迁移使用来源提交中的已跟踪文件，不包含 `node_modules`、`dist`、覆盖率、Playwright 输出或其他本地缓存，也没有修改来源仓库。

## 本次迁移范围

已迁移：

- `src/` 中的页面、组件、样式、领域模型、Gateway 和 fixture。
- Jest 单元测试与 Playwright E2E 用例。
- Grafana 官方脚手架生成的 `.config/` 和 Webpack 配置。
- npm manifest、lockfile、TypeScript、ESLint、Prettier 配置。
- 插件开发所需的 Compose、provisioning 和 Grafana 配置。
- 原有薄 Plugin Backend 源码和 Mage 配置。

原有薄 Plugin Backend 被复制只是为了保留完整的 Grafana App Plugin 结构。本阶段不修改、不扩展也不验证其 Go 构建；它仍引用旧仓库中的共享 Go API，因此在新的 Control Plane 契约确定前不能视为可独立发布的后端。

原插件目录中的 `.github/workflows` 迁移后位于 `grafana-plugin/.github/workflows`，GitHub 不会把嵌套目录识别为仓库级 Workflow。它们目前只是迁移参考；新仓库的基础 CI 将在阶段 0 的后续任务中建立于根目录 `.github/workflows`。

## 有意保留的兼容项

- Grafana Plugin ID 暂时仍为 `grafana-plugin-app`。
- URL 中依赖 Plugin ID 的路径暂时不变。
- `plugin.json` 仍声明 backend 和原执行文件名。
- fixture 继续存在，供页面单测和离线 UI 开发使用。

Plugin ID 会影响 Grafana 路由、插件配置、签名和已安装实例，不能只做字符串替换。应在第一次正式发布前通过 ADR 决定是否切换为符合发布账号要求的新 ID，并一次性完成路由、provisioning、测试和签名配置迁移。

## 品牌调整

产品展示名称已改为 **Aegis SRE**，但没有修改 Plugin ID 或 Plugin 类型。`plugin.json` 的修改需要重新启动 Grafana 才能在开发实例中生效。

## 后续清理门槛

满足以下条件后，才能删除旧 Plugin Backend 或旧 Gateway：

1. Control Plane OpenAPI 和流事件协议已经冻结。
2. 新 Resource Gateway 的契约测试通过。
3. Grafana 中 Workbench、Knowledge、Playbook 主路径完成 E2E 验收。
4. 已明确浏览器、Plugin Backend 与 Control Plane 之间的身份传递方式。
5. 与原代码作者确认删除范围。

## 迁移验证结果

在 Node.js `v22.23.1`、npm `10.9.8` 下完成：

- `npm ci`：成功。
- `npm run typecheck`：成功。
- `npm run lint`：成功；依赖输出 `@stylistic/eslint-plugin-ts` 已弃用提示。
- `npm run test:ci`：49 个测试套件、248 个测试全部通过。
- `npm run build`：成功，生成 `dist/module.js` 和插件发布资源。

Jest 运行中仍有迁移前已有的 React Router future flag 提示和个别 `act(...)` 警告。这些警告不影响本次基线通过结果，后续修改相关测试时应逐步消除。
