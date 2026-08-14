# ADR 0005：Agent 调用 Playbook 的 MCP 边界

- 状态：接受
- 日期：2026-08-14

## 背景

固定版本 Dagu `2.13.0` 提供 REST/CLI 执行接口以及受白名单约束的 `mcp.call` Action，
用于 Dagu → 外部 MCP；该版本没有可供 OpenCode/Codex 直接发现和调用的原生 Dagu MCP
Server。现有 Agent 因此只能调用 Grafana MCP，不能通过 MCP 查询或启动 Playbook。

直接把 Dagu REST 私有协议注册给 Agent 会绕过 `internal/ports.PlaybookProvider`、暴露
Dagu Provider 语义，也会形成第二套 Agent → Workflow 调用协议。

## 决策

1. Aegis 增加一个薄的 Playbook MCP facade，挂在 Control Plane 的 `/mcp/playbooks`。
   facade 只把受授权的 MCP 工具映射到现有 `ports.PlaybookProvider`，不实现调度、重试、
   状态机或 YAML 解析。
2. Playbook MCP 只暴露 Agent 当前需要的最小工具：查询、校验、启动和读取 Run；取消、
   重试、Human Task、Approval 和 Artifact 操作继续由 Control Plane REST/SSE 提供给插件，
   除非后续 Agent 场景证明需要，再通过兼容性扩展加入工具。
3. Agent 使用显式的 Playbook MCP bearer token 和固定 Actor 范围。缺少 token、Actor 或
   Playbook provider 时，endpoint 不注册，能力返回 `unavailable`。
4. Agent 不直接连接 Dagu；Dagu 的 Provider 类型、内部 DAG 文件名和 REST schema 只存在
   `internal/adapters/dagu` 与 HTTP adapter 内部。
5. Dagu Workflow 内的 `mcp.call` 仍只允许调用 Grafana 等外部 MCP，禁止递归调用自身的
   Playbook MCP 或执行工具。
6. Knowledge MCP 不加入 Agent 的默认配置。Playbook MCP 与 Knowledge/RAGFlow 完全独立，
   RAGFlow 未启动不影响 Agent + Playbook 链路。

## 结果

- Agent → Playbook 使用版本化 MCP 协议，同时复用已有 Playbook port，不重复实现 Workflow 引擎。
- 插件仍通过 REST/SSE 使用完整 Playbook 运维能力；Agent 工具面和 UI 管理面职责分离。
- 后续如果 Dagu 提供稳定原生 MCP，可在新的 ADR 中替换 facade，保留公共工具契约和验收测试。

## 验收门禁

- MCP contract test 能发现并调用查询、校验、启动、读取 Run 工具。
- 未授权 Actor、无效 Playbook ID、无效 YAML 和 provider 不可用均 fail-closed。
- OpenCode/Codex 默认工具列表包含 Grafana Read 与 Playbook MCP，不包含 Knowledge MCP。
- 组合 E2E 能完成 Agent 启动 Playbook，且 Dagu `mcp.call` 能调用 Grafana。
