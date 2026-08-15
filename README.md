# Aegis SRE

Aegis SRE 是一个以 Grafana App Plugin 为入口的开源 SRE 工作台。项目本身只维护产品控制面与必要的集成层，Agent、知识检索、Playbook 编排和 Grafana 工具能力分别交给成熟组件。

当前已完成仓库基线、无状态 Control Plane、v1 公共契约、Plugin Backend 受信代理，以及 Dagu Playbook 到只读 Grafana MCP 的基本执行链。阶段 6 的 Agent 核心链路已经接入 Codex App Server 与 OpenCode Server。阶段 8 已完成 Provider-neutral Knowledge 端口、RAGLite sidecar 与 adapter、RAGFlow 回退 adapter、管理与检索界面、受限 MCP endpoint，以及 OpenCode/Dagu 注册；真实数据质量、迁移和重启恢复仍待用运维文档验收。Codex Knowledge MCP 注册、OpenCode 审批续流和统一 MCP 启动校验仍是明确缺口。

## 目标组件

| 能力 | 组件 | Aegis SRE 的职责 |
| --- | --- | --- |
| Grafana 内产品界面 | Grafana App Plugin | 页面、交互、Resource Gateway |
| 产品控制面 | Aegis Control Plane | 稳定 API、授权收敛、协议归一化、Provider 适配 |
| Agent | Codex App Server；OpenCode 可替换 | 仅通过 `AgentProvider` 接入 |
| 知识库 | RAGLite（默认目标）；RAGFlow（迁移期回退） | Collection、文档解析、Chunk、Embedding、检索 |
| Playbook | Dagu | 原生 YAML、调度、审批、运行、日志、Artifact |
| Grafana 工具 | Grafana 官方 MCP Server | 指标、日志、告警、Dashboard 等工具 |
| Workflow 出站工具 | `mcp.call` Dagu Action | 受白名单约束地调用外部 MCP 工具 |

## 仓库现状

```text
aegis-sre/
├── api/                         # OpenAPI 与统一事件 Schema
├── cmd/control-plane/           # Control Plane 进程入口
├── internal/                    # 领域、Provider ports 与必要 adapter
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

要求 Go 1.26、Node.js 22、Docker Compose、`jq` 和 `openssl`；当前阶段不需要自有数据库。

```bash
make verify
go run ./cmd/control-plane
```

完整本地链路可由根 Compose 启动：

```bash
make local-secrets
make local-up
make local-smoke
```

`local-secrets` 只在 git 忽略的 `deploy/local/secrets/` 生成开发凭据。运行前需要把 DeepSeek API Key 写入 `deploy/local/secrets/deepseek-api-key`；脚本不会生成或提交 Provider 凭据。启动过程会创建 Grafana Viewer Service Account；Grafana 默认只绑定 `127.0.0.1:3000`，Dagu 只绑定 `127.0.0.1:18081`，Control Plane、OpenCode、只读 Grafana MCP 和其鉴权网关不发布主机端口。可用 `GRAFANA_PORT`、`DAGU_PORT` 覆盖两个开发端口；运行冒烟时需传递相同的 `DAGU_PORT`。

`local-smoke` 同时验证 Dagu 到 Grafana MCP 的底层路径、Grafana Plugin 经 Control Plane 管理和运行原生 Dagu Playbook 的产品路径，以及 OpenCode 到 DeepSeek 的真实文本会话；任一路径不可用都会明确失败。

Knowledge 是可选部署，不影响基础栈独立运行。默认的轻量 RAGLite 启动与恢复流程见 [RAGLite 本地部署](deploy/raglite/README.md)；迁移窗口内的 [RAGFlow 本地部署](deploy/ragflow/README.md) 仅用于显式回退和对比验收。

Plugin Backend 通过以下环境变量连接 Control Plane：

- `AEGIS_CONTROL_PLANE_URL`：必填的 Control Plane HTTP origin。
- `AEGIS_CONTROL_PLANE_TOKEN_FILE`：可选的只读 Bearer Token 文件路径；启用时，Control Plane 的 `AEGIS_PLUGIN_TOKEN_FILE` 应读取同一凭据。
- `AEGIS_DAGU_BASIC_AUTH_USERNAME` 与 `AEGIS_DAGU_BASIC_AUTH_PASSWORD_FILE`：Control Plane 访问 Dagu 的服务凭据，必须成对配置，且不能与 Dagu Bearer Token 同时配置。

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
- [轻量 Knowledge Provider 替换调研](docs/research/lightweight-rag-replacement-research.md)
- [RAGLite 接入详细调研](docs/research/raglite-integration-research.md)
- [历史 RAGFlow 选型调研](docs/research/knowledge-base-replacement-research.md)

## 当前明确不做的事情

- 不继续维护自研 Agent 编排、Checkpoint 或 Planner/Executor。
- 不实现自研文档解析、切分、Embedding 或向量检索。
- 不维护第二套 Playbook DSL 和执行引擎。
- 不重写 Grafana 官方 MCP 已经提供的工具。
- 不让浏览器直接持有 Knowledge、Dagu、Grafana MCP 或 Agent Provider 凭据。
- 不在 Plugin Backend 中实现业务逻辑；它只负责受信身份注入和 REST/SSE 代理。
- 不在 Control Plane 中复制 Agent、Dagu、Knowledge Provider 或 Grafana 已持有的数据；确需自有状态时先提交 ADR。

## License

项目采用 [Apache License 2.0](LICENSE)。Dagu、RAGFlow、Grafana MCP、Codex/OpenCode 等独立部署组件继续遵循各自许可证，不复制到本仓库中维护。
