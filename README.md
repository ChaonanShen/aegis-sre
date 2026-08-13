# Aegis SRE

Aegis SRE 是一个以 Grafana App Plugin 为入口的开源 SRE 工作台。项目本身只维护产品控制面与必要的集成层，Agent、知识检索、Playbook 编排和 Grafana 工具能力分别交给成熟组件。

当前已完成实施计划的阶段 0–3：仓库迁移基线、Control Plane 骨架、v1 公共契约、PostgreSQL 持久化基础，以及 Grafana Plugin Backend 到 Control Plane 的受信代理。阶段 4 的 Dagu 接入尚未开始。

## 目标组件

| 能力 | 组件 | Aegis SRE 的职责 |
| --- | --- | --- |
| Grafana 内产品界面 | Grafana App Plugin | 页面、交互、Resource Gateway |
| 产品控制面 | Aegis Control Plane | 稳定 API、业务 ID、关联关系、Provider 适配 |
| Agent | Codex App Server；OpenCode 可替换 | 仅通过 `AgentProvider` 接入 |
| 知识库 | RAGFlow | Dataset、文档解析、Chunk、Embedding、检索 |
| Playbook | Dagu | 原生 YAML、调度、审批、运行、日志、Artifact |
| Grafana 工具 | Grafana 官方 MCP Server | 指标、日志、告警、Dashboard 等工具 |
| Workflow 出站工具 | `mcp.call` Dagu Action | 受白名单约束地调用外部 MCP 工具 |

## 仓库现状

```text
aegis-sre/
├── api/                         # OpenAPI 与统一事件 Schema
├── cmd/control-plane/           # Control Plane 进程入口
├── internal/                    # 领域、端口、应用层与 Provider adapter
├── migrations/                  # PostgreSQL migrations
├── grafana-plugin/              # Grafana 前端与薄 Plugin Backend
├── docs/
│   ├── architecture.md          # 目标架构和稳定边界
│   ├── implementation-plan.md   # 分阶段执行计划与验收标准
│   ├── migration-notes.md       # 迁移来源与已知限制
│   └── research/                # 已有调研材料
└── Makefile                     # 本地与 CI 的统一验证入口
```

尚未接入的能力会返回明确的 `capability_unavailable`，真实运行模式不会静默回退到 fixture 或 mock。

## 本地验证与运行

要求 Go 1.26.4、Node.js 22，以及可用的 PostgreSQL 18。

```bash
make verify
AEGIS_DATABASE_URL='postgres://aegis:aegis@localhost:5432/aegis?sslmode=disable' make db-up
AEGIS_DATABASE_URL='postgres://aegis:aegis@localhost:5432/aegis?sslmode=disable' go run ./cmd/control-plane
```

Plugin Backend 通过以下环境变量连接 Control Plane：

- `AEGIS_CONTROL_PLANE_URL`：必填的 Control Plane HTTP origin。
- `AEGIS_CONTROL_PLANE_TOKEN_FILE`：可选的只读 Bearer Token 文件路径；启用时，Control Plane 的 `AEGIS_PLUGIN_TOKEN_FILE` 应读取同一凭据。

## 前端开发

要求 Node.js 22 或更高版本。

```bash
cd grafana-plugin
npm ci
npm run typecheck
npm run test:ci
npm run build
```

## 实施入口

- [目标架构](docs/architecture.md)
- [详细实施计划](docs/implementation-plan.md)
- [迁移记录](docs/migration-notes.md)
- [RAGFlow 替换调研](docs/research/knowledge-base-replacement-research.md)

## 当前明确不做的事情

- 不继续维护自研 Agent 编排、Checkpoint 或 Planner/Executor。
- 不实现自研文档解析、切分、Embedding 或向量检索。
- 不维护第二套 Playbook DSL 和执行引擎。
- 不重写 Grafana 官方 MCP 已经提供的工具。
- 不让浏览器直接持有 RAGFlow、Dagu、Grafana MCP 或 Agent Provider 凭据。
- 不在 Plugin Backend 中实现业务逻辑；它只负责受信身份注入和 REST/SSE 代理。

## License

项目采用 [Apache License 2.0](LICENSE)。Dagu、RAGFlow、Grafana MCP、Codex/OpenCode 等独立部署组件继续遵循各自许可证，不复制到本仓库中维护。
