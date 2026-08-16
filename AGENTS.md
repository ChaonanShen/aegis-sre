# Aegis SRE 工作规范

## 架构边界

- Aegis SRE 只实现产品控制面和必要适配，不重新实现 Agent、RAG、Workflow 引擎或 Grafana MCP 已提供的通用能力。
- Provider 类型、内部 ID 和 SDK 类型不得进入前端公共契约或领域模型。
- Agent、Knowledge、Playbook 必须通过 `internal/ports` 中的稳定接口接入；Provider 特有协议只允许存在于对应 adapter。
- Playbook 以原生 Dagu YAML 为唯一事实来源，不增加自定义 DSL。
- Agent 使用 MCP 访问 Grafana、Knowledge 和 Dagu；插件管理操作通过 Control Plane API，不直接访问 Provider。
- 稳定架构基线见 [`docs/architecture.md`](docs/architecture.md)；实现跨模块改动、新增服务或替换 Provider 前必须先对照并在必要时更新该文档或提交 ADR，避免演变为无边界的微服务集合。

## 代码修改

- 为不易理解的逻辑补充简洁、准确的中文注释，说明代码的作用和约束。
- 测试应覆盖明确行为和回归风险，不添加重复、脆弱或只追求数量的测试。
- 外部组件和协议必须固定版本；升级时运行对应契约测试和端到端验收。
- 真实运行模式不得静默回退到 fixture 或 mock 数据。

## 删除代码

- 删除迁移自旧项目的已有代码前，先与该处代码的作者确认；无法确认时记录原因、兼容窗口和回退方式。
- Provider 切换后，旧实现至少保留一个到两个发布周期的只读或可回退能力，再讨论删除。

## 发现疑点时

如果现有决定会导致重复实现、Provider 类型泄漏、权限边界绕过、数据事实来源不唯一或无法解释的复杂度，应暂停修改，在文档或 ADR 中说明问题并先确认方向。

## Grafana Plugin

修改 `grafana-plugin/` 时还必须遵守该目录中的 `AGENTS.md`。`.config/` 由 Grafana 插件工具管理，不得手工修改。
