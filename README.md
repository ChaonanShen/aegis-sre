# Aegis SRE

Aegis SRE 是一个以 Grafana App Plugin 为入口的开源 SRE 工作台。项目本身只维护产品控制面与必要的集成层，Agent、知识检索、Playbook 编排和 Grafana 工具能力分别交给成熟组件。

当前仓库已经从 Torchbearing 迁入 Grafana 插件工程。前端页面、Gateway 边界、单元测试和构建配置保持原有结构；现有 Plugin Backend 仅为保证插件工程结构完整而原样保留，本阶段不开发，也不代表最终后端设计。

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
├── grafana-plugin/              # 已迁移；当前唯一实现代码
├── docs/
│   ├── architecture.md          # 目标架构和稳定边界
│   ├── implementation-plan.md   # 分阶段执行计划与验收标准
│   ├── migration-notes.md       # 迁移来源与已知限制
│   └── research/                # 已有调研材料
└── README.md
```

后续目录会按实施计划逐步增加，当前不会提前创建空的微服务或占位实现。

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
- 不在第一阶段扩展 Plugin Backend；鉴权设计在接口中预留，在后续阶段落地。

## License

项目采用 [Apache License 2.0](LICENSE)。Dagu、RAGFlow、Grafana MCP、Codex/OpenCode 等独立部署组件继续遵循各自许可证，不复制到本仓库中维护。
