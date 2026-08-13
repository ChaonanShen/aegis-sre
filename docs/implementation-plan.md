# Aegis SRE 详细实施计划

## 1. 计划目标

以已迁移的 Grafana Plugin Frontend 为产品入口，逐步完成以下可替换架构：

- Codex 为默认 Agent，OpenCode 为可替换实现。
- RAGFlow 为知识解析与检索引擎。
- Dagu 为 Playbook 定义和运行引擎。
- Dagu 支持经过白名单约束的 `mcp.call` 自定义 Action。
- Grafana 官方 MCP、Aegis Knowledge MCP、Dagu MCP 同时供 Agent 使用。
- 不复活旧 Agent、RAG、Playbook 或 Grafana Tool 自研实现。

实施采用“契约先行、垂直切片、能力显式启用”的顺序：先完成仓库基线、Control Plane
最小骨架和公共契约冻结，再逐个接入 Provider。未完成真实接入的能力不得注册到 Agent，
也不得在真实模式中回退到 fixture。

RAGFlow 依赖较多、资源占用较大，放在 Dagu、Grafana MCP 和 Agent 主链路稳定之后接入。
Knowledge 的公共接口仍在前期冻结，避免延后部署 RAGFlow 反过来阻塞领域边界设计。

## 2. 全局完成标准

最终版本至少完成一条真实闭环：

1. 用户在 Grafana 插件选择告警或输入问题。
2. Agent 调 Grafana MCP 查询指标、日志、告警规则和 Dashboard 上下文。
3. Agent 调 Knowledge MCP 检索服务文档与历史故障。
4. Agent 调 Dagu MCP 查找或准备 Playbook。
5. 用户批准高风险操作。
6. Dagu 启动 Playbook，Workflow 中的 `mcp.call` 调用允许的外部工具。
7. 插件持续显示 Agent 事件、Dagu Step 状态和最终 Artifact。
8. 同一场景可切换到 OpenCode，前端和业务 API 不改变。

## 3. 阶段 0：仓库与前端基线

状态：**已完成。迁移基线、根目录 CI 与统一验证入口均已建立。**

任务：

- [x] 创建 `/Users/a1111/proj/aegis-sre`。
- [x] 执行 `git init -b main`。
- [x] 迁移 Grafana Plugin 已跟踪文件。
- [x] 排除依赖、构建产物和本地缓存。
- [x] 记录来源提交和迁移边界。
- [x] 建立目标架构和实施计划。
- [x] 运行 `npm ci`。
- [x] 通过 TypeScript 类型检查。
- [x] 通过 ESLint。
- [x] 通过 Jest 测试：49 个测试套件、248 个测试。
- [x] 通过生产 Webpack 构建并生成 `dist/module.js`。
- [x] 建立新仓库基础 CI。

验收标准：

- 前端迁移前后的 Jest 测试数和结果一致。
- Webpack 能生成完整 `dist/`。
- `git status` 不包含 `node_modules`、`dist` 或密钥。
- Plugin Backend 未被误认为新的 Control Plane。

当前测试基线仍会输出 React Router v7 future flag 提示和少量异步状态更新未包装 `act(...)` 的警告。它们来自迁移前代码，不阻塞本阶段，但应在改动对应测试时逐步清理，避免长期掩盖新的测试告警。

## 4. 阶段 1：Control Plane 最小骨架

状态：**已完成。**

目标：建立一个可独立构建和运行的 Go 模块化单体，但暂不接入任何 Provider 或展开业务实现。

建议新增：

```text
cmd/control-plane/
internal/domain/
internal/application/
internal/ports/
internal/adapters/
```

任务：

- [x] 初始化 Go module，设置统一 lint、test 和 build 命令。
- [x] 实现 `/health/live` 和 `/health/ready`。
- [x] 建立配置加载、结构化日志、request ID、trace ID 和受控错误模型。
- [x] 建立依赖装配和优雅关闭，不创建 RAG、Workflow 或 Agent 运行时。
- [x] 将配置分为必需、可选和敏感项；未配置 Provider 时服务仍可启动并明确报告能力不可用。
- [x] 建立根目录统一开发命令，使前端和 Control Plane 可分别验证。

验收标准：

- Control Plane 不依赖 RAGFlow、Dagu、Agent 或 Grafana MCP 即可启动。
- `/health/live` 只反映进程存活，`/health/ready` 能表达依赖尚未配置。
- 日志不输出凭据、请求正文或 Provider 原始敏感错误。
- Go 单元测试和构建可以在新仓库内独立完成，不再依赖旧仓库的 `../api`。

## 5. 阶段 2：公共契约与 Provider Ports 冻结

状态：**已完成首个 v1 契约基线；后续只允许兼容性演进。**

目标：在接入任一外部组件前，冻结前端、Control Plane 和 Provider Adapter 共同依赖的稳定边界。

建议新增：

```text
api/openapi.yaml
api/events.schema.json
internal/domain/
internal/ports/
internal/application/contracts/
```

任务：

- [x] 定义 `ActorContext`，所有 Application Service 和 Provider 调用显式接收它。
- [x] 定义稳定业务 ID、分页、版本、幂等键、错误码和 Problem Response。
- [x] 定义 `AgentProvider`、`KnowledgeProvider`、`PlaybookProvider`，接口中禁止出现 Provider SDK 类型。
- [x] 定义统一 SSE Event Envelope、事件序号、终态、断线重连和去重规则。
- [x] 冻结 Session、Turn、Approval、Playbook、Run、KnowledgeBase、Document 和 ServiceEntry 的公开 Schema。
- [x] 明确 Provider ID 只存在于 adapter 和持久化映射中，不进入普通前端响应。
- [x] 定义能力发现机制；未接入的 Knowledge、Playbook 或 Agent 能力返回稳定的 `capability_unavailable`。
- [x] 生成 OpenAPI client 和事件类型，禁止前后端手写重复 DTO。
- [x] 加入 Provider contract fake，只用于接口测试，不作为真实运行模式的 fixture 或静默 fallback。

验收标准：

- API 类型、领域类型、数据库模型和 Provider SDK 类型彼此分离。
- OpenAPI 与 Event Schema 有兼容性检查，破坏性变更必须显式升级版本。
- Provider ID、凭据和私有错误不出现在公开 Schema。
- 任意 Provider 超时都映射为稳定业务错误。
- 同一个幂等键不能创建两个 Agent Turn、文档或 Playbook Run。
- 单元测试不需要启动 RAGFlow、Dagu、Agent 或 Grafana MCP。

## 6. 阶段 3：Control Plane 持久化与 Plugin Gateway

状态：**已完成。阶段 4 的 Dagu 接入尚未开始。**

目标：让 Grafana Plugin 通过薄 Plugin Backend 访问冻结后的 Control Plane 契约，为后续 Provider 垂直切片建立唯一入口。

任务：

- [x] 建立 PostgreSQL migrations 和 repository。
- [x] 实现业务 ID 与 Provider ID 映射 repository，但不预建 Provider 业务逻辑。
- [x] 建立 operation idempotency、approval reference 和跨组件 trace 关联。
- [x] Plugin Backend 从 Grafana PluginContext 提取受信的用户、Org 和请求上下文。
- [x] Plugin Backend 只做 REST/SSE 透明代理、超时和受控错误转发。
- [x] 移除 Plugin Backend 对旧仓库 `../api` 的构建依赖。
- [x] 前端 Resource Client 只根据 OpenAPI 和 Event Schema 生成或适配。
- [x] 为 REST、SSE、身份伪造、请求取消和错误净化建立契约测试。

首批数据库对象：

```text
services
knowledge_bases
knowledge_documents
provider_collections
provider_documents
agent_sessions
playbook_refs
playbook_run_refs
approval_refs
operation_idempotency
```

验收标准：

- Grafana 浏览器只访问 Grafana Resource API，不知道 Control Plane 地址和服务凭据。
- Plugin Backend 不包含 Agent 编排、知识检索或 Playbook 运行逻辑。
- 数据库事务、乐观锁和幂等冲突有明确行为测试。
- 未接入的产品能力在真实模式下明确不可用，不读取 fixture。

## 7. 阶段 4：Dagu 与 `mcp.call`

目标：Dagu 成为 Playbook 唯一执行引擎，插件不再依赖自定义 DSL。

### 4.1 迁入实验成果

从 `/Users/a1111/proj/codex-playbook-dagu` 迁入并整理：

- [ ] Dagu REST client 和 API 类型。
- [ ] 原生 YAML 解析与前端 DAG 映射。
- [ ] Run、Step、日志、Artifact 查询。
- [ ] `human.task` 表单提交。
- [ ] Approval approve/reject/rewind。
- [ ] `mcp.call` Runner、配置和验收用例。

迁入时不得复制实验用 Prometheus MCP 实现，正式环境直接使用 Grafana 官方 MCP。

### 4.2 Playbook Provider

- [ ] YAML CRUD 和服务端 validate。
- [ ] Run、enqueue、cancel、retry。
- [ ] Run/Step 状态映射和事件轮询。
- [ ] Human Task 与 Approval 统一映射。
- [ ] Artifact 列表、预览和下载代理。
- [ ] 业务 Playbook ID 到 Dagu DAG 名称/路径映射。
- [ ] GitOps 与 UI 写入冲突策略 ADR。

### 4.3 `mcp.call` 生产化

- [ ] Server 和 Tool 双重 allowlist。
- [ ] 连接、握手、调用和总超时。
- [ ] 最大文本、结构化内容和二进制结果限制。
- [ ] Bearer Token file、CA 和可选 mTLS。
- [ ] Text、Image、Audio、ResourceLink 和 Embedded Resource 归一化。
- [ ] 大结果进入 Dagu Artifact，只在 Step 输出中返回摘要和路径。
- [ ] 为写操作传递幂等键和 trace ID。
- [ ] 禁止调用 Dagu 自身执行类工具形成递归。
- [ ] Write Tool 默认拒绝，逐项评审加入。

本阶段使用只实现允许工具的 MCP contract server 验证 `mcp.call` 协议、限制和 Artifact；
不得迁入实验用 Prometheus MCP。对 Grafana 官方 MCP 的真实调用在阶段 5 补充验收。

### 4.4 前端接入

- [ ] 使用原生 Dagu YAML 作为编辑内容和事实来源。
- [ ] 迁移 Playbook DAG 可视化，不反向生成第二套 DSL。
- [ ] 实现真实 `PlaybookGateway`。
- [ ] 展示 Run、Step、Human Task、Approval 和 Artifact。
- [ ] 删除真实模式下的 Playbook fixture fallback。

验收标准：

- CRUD、validate、run、cancel、retry 可用。
- Human Task 和 Approval 暂停后可以从插件恢复运行。
- 四个并行 `mcp.call` 节点能通过 contract server 稳定完成并生成报告 Artifact。
- 未在 allowlist 中的工具在连接前或调用前被明确拒绝。
- Dagu 重启后仍能读取既有 DAG 和运行记录。

## 8. 阶段 5：Grafana 官方 MCP

目标：完全替代自研 Grafana/Prometheus MCP 工具。

任务：

- [ ] 固定 `grafana/mcp-grafana` 版本。
- [ ] 部署 `grafana-read`，强制 `--disable-write`。
- [ ] 只启用当前产品需要的工具类别。
- [ ] 为服务端启用调用方 Bearer Token。
- [ ] 设置 allowed hosts/origins 和 TLS 或可信反向代理。
- [ ] 使用文件挂载 Service Account Token，支持轮换。
- [ ] 按需部署 `grafana-write`，使用独立低权限账号。
- [ ] 发布供后续 Codex、OpenCode 和 `mcp.call` 消费的版本化连接配置。
- [ ] 为常用 PromQL、LogQL、告警和 Dashboard 工具建立冒烟测试。
- [ ] 使用阶段 4 的 `mcp.call` Runner 对 `grafana-read` 完成真实调用验收。

初期权限：

- 默认 Agent 只获得 `grafana-read`。
- 写实例不自动加入所有 Agent Session。
- Dagu 只有特定 Playbook 可以使用写实例。
- 所有写动作需要 Aegis Approval 或 Dagu Approval。

验收标准：

- 未授权调用不能列出或执行写工具。
- MCP 调用方 Token 与 Grafana Service Account Token 相互独立。
- 独立 MCP 冒烟客户端和 Dagu `mcp.call` 可完成指标、日志、告警和 Dashboard 只读查询。
- 服务账号轮换不要求重启整个 Aegis 栈。

## 9. 阶段 6：Codex 与 OpenCode Agent Provider

目标：Codex 作为默认 Provider，同时用 OpenCode 证明抽象没有泄漏。

### 6.1 Codex Adapter

- [ ] 固定 Codex CLI/App Server 版本。
- [ ] 由 Control Plane 管理持久 `stdio + JSONL` 子进程。
- [ ] 完成 initialize/initialized 握手。
- [ ] 实现 thread start/resume/read/delete。
- [ ] 实现 turn start/interrupt。
- [ ] 映射 message delta、MCP call、完成和失败事件。
- [ ] 处理命令、文件变更和 MCP 工具审批请求。
- [ ] 启动时校验当前声明启用的 Grafana 和 Dagu MCP；Knowledge 未接入前不得注册虚假工具。
- [ ] 保存业务 Session 与 Codex Thread ID 映射。
- [ ] 使用生成的版本化 JSON Schema 做协议兼容测试。

### 6.2 OpenCode Adapter

- [ ] 固定 OpenCode 版本。
- [ ] 使用带 Basic Auth 的 headless HTTP server。
- [ ] 实现 session create/read/delete/abort。
- [ ] 实现 async prompt 和 SSE event 订阅。
- [ ] 映射 message part、tool call、permission 和完成事件。
- [ ] 配置与 Codex 一致的已启用 MCP；Knowledge 在 RAGFlow 阶段完成后再加入。

### 6.3 Provider 合同测试

同一套测试必须对 Codex 和 OpenCode 执行：

- [ ] 创建、读取和删除会话。
- [ ] 发送消息并按序收到增量事件。
- [ ] 调用当前已启用的 Grafana 和 Dagu MCP 工具。
- [ ] 拒绝和接受审批。
- [ ] 中断运行中的 Turn。
- [ ] Provider 重启后恢复会话。
- [ ] 重复幂等请求不创建重复 Turn。

验收标准：切换 `AGENT_PROVIDER=codex|opencode` 后，插件请求和事件 Schema 不变化。

## 10. 阶段 7：核心前端真实模式收口

目标：先收口不依赖 RAGFlow 的真实功能；Knowledge 页面保持明确不可用，直到最后的 RAGFlow 垂直切片完成。

任务：

- [ ] 生成或实现 Control Plane Resource Client。
- [ ] Workbench 使用统一 Agent Event，不再识别旧 AgentType。
- [ ] Playbook 使用 Dagu-backed API。
- [ ] Approvals 汇总 Agent Approval 与 Dagu Approval。
- [ ] Alerts 接入真实 Grafana 告警上下文。
- [ ] Audit 页面接入跨 Provider trace 和操作摘要。
- [ ] fixture 仅在显式 fixture/test 模式启用。
- [ ] 真实模式中未实现能力显示明确不可用，不静默返回 fixture 数据。
- [ ] 更新 Playwright 用例覆盖 Grafana、Dagu 和 Agent 的真实服务组合。

验收标准：

- 真实模式不读取 fixture store。
- Provider ID 和凭据不出现在浏览器响应、URL 或日志中。
- SSE 断线后可从最后事件序号恢复或明确终止。
- 页面卸载时会取消不再需要的请求和流。

## 11. 阶段 8：RAGFlow 与 Knowledge 最终垂直切片

目标：在其他主链路稳定后，完成 `Grafana Plugin → Control Plane → RAGFlow` 的真实知识链路，并把 Knowledge MCP 加入 Agent。

### 8.1 基础部署

- [ ] 固定 RAGFlow 版本和镜像 digest。
- [ ] 为 MySQL、Redis、对象存储和检索引擎配置持久卷。
- [ ] 配置外部 Embedding 服务。
- [ ] 建立 readiness、备份和恢复说明。
- [ ] 记录最低资源、开发机降配方式，以及不启动 RAGFlow 时其他模块的独立开发方式。

### 8.2 Knowledge Adapter

- [ ] Dataset 创建、更新和删除。
- [ ] 文档上传、开始解析、停止解析和删除。
- [ ] 文档解析状态轮询与状态映射。
- [ ] 文档、Chunk 分页浏览。
- [ ] 混合检索、阈值、Top K 和引用位置映射。
- [ ] 请求超时、重试、限流和错误净化。
- [ ] Dataset/Document Provider ID 映射。

### 8.3 Knowledge MCP

- [ ] 在 Control Plane 中暴露 Streamable HTTP MCP endpoint。
- [ ] 实现 `knowledge.search`。
- [ ] 实现 `knowledge.get_document`。
- [ ] 实现 `knowledge.list_sources`。
- [ ] MCP 工具只接受业务 ID，不接受 Provider Dataset ID。
- [ ] 检索前根据 Actor、Folder 和 Service 收敛范围。
- [ ] 限制结果数量、单 Chunk 长度和总响应大小。
- [ ] 真实检索与授权测试通过后，才把 Knowledge MCP 注册到 Codex 和 OpenCode。

### 8.4 前端接入

- [ ] 实现真实 `KnowledgeGateway`。
- [ ] 将 Runbook 从 Knowledge 模型迁出，归入 Playbook。
- [ ] 替换真实模式下的 Knowledge fixture fallback。
- [ ] 展示解析状态、失败原因、引用和原文位置。

验收数据集：30～50 份真实运维文档，覆盖中文、错误码、PromQL、日志、Markdown 代码块、PDF 表格和 DOCX 标题。

验收指标：

- 解析成功率不低于 95%。
- 人工标注片段进入 Top 5 的比例不低于 85%。
- 无权范围的检索请求 100% 被拒绝。
- 删除文档后在约定时间内不再返回其 Chunk。
- RAGFlow 不可用时，前端收到 Aegis 受控错误而不是内部响应体。
- 不启动 RAGFlow 时，Grafana、Dagu 和 Agent 已完成的链路仍可独立开发和运行。

## 12. 阶段 9：端到端业务闭环

首个黄金场景：**告警诊断并执行受控 Playbook**。

固定测试步骤：

1. 在 Grafana 中准备可触发的测试告警和指标/日志数据。
2. 在 RAGFlow 导入服务说明、历史故障和操作约束。
3. 在 Dagu 准备只读诊断 Playbook 和需审批修复 Playbook。
4. 从插件告警页创建 Agent Session。
5. 验证 Agent 读取 Grafana、Knowledge 和 Dagu。
6. 验证 Agent 给出带引用的分析结论。
7. 验证写操作进入审批而不是直接执行。
8. 批准后启动 Dagu Run。
9. 验证 Dagu `mcp.call` 调用 Grafana MCP。
10. 验证插件展示 Step 状态、日志摘要和 Artifact。

故障注入：

- [ ] Grafana MCP 不可用。
- [ ] RAGFlow 检索超时。
- [ ] Dagu Run 失败和重试。
- [ ] Agent Provider 中途重启。
- [ ] SSE 连接断开并恢复。
- [ ] 用户拒绝审批。
- [ ] 重复提交同一操作。

## 13. 阶段 10：身份、安全与生产化

前期已经传递最小 Actor Context；本阶段完成生产身份校验、细粒度授权和运行安全，
不能再继续使用开发环境固定身份或仅依赖网络边界。

任务：

- [ ] Plugin Backend 补全并验证 Grafana Org、用户、角色和 Folder 授权上下文。
- [ ] Control Plane 校验受信来源、Actor Context 完整性和调用链签名或等价凭证。
- [ ] Folder 级 Knowledge 授权。
- [ ] Dagu 和 Grafana 写操作角色映射。
- [ ] Agent 文件系统、网络和命令权限 Profile。
- [ ] Secret Manager、Token 轮换和吊销。
- [ ] 完整审计、敏感字段脱敏和保留策略。
- [ ] TLS/mTLS、NetworkPolicy 和出站 allowlist。
- [ ] PostgreSQL、RAGFlow、Dagu 数据备份恢复演练。
- [ ] Provider 容量、并发、队列和限流。
- [ ] OTel traces、metrics、logs 和跨组件 trace ID。

## 14. 版本与升级规则

每个外部组件必须在部署清单中记录：

```text
component
version
image digest
API/protocol version
configuration checksum
upgrade date
rollback version
```

升级门槛：

- Adapter contract tests 通过。
- RAGFlow 上传、解析、检索和删除评测通过。
- Dagu YAML validate、Run、Human Task、Approval、Artifact 通过。
- Agent 会话、事件、审批和 MCP 调用通过。
- Grafana MCP 只读与写工具边界通过。
- 黄金 E2E 场景通过。

## 15. 暂不迁移与删除清单

新仓库不迁移旧实现：

- Eino Agent runtime、模型 Provider、Checkpoint、HITL 实现。
- 自研 Grafana/Prometheus MCP Server。
- Parser、Chunker、Embedding Worker、pgvector 和混合检索。
- 自研 Playbook 执行器和 DSL。

旧仓库中的对应代码暂时不删除。待新链路运行一到两个发布周期，并与原作者确认后再处理。

## 16. 近期执行顺序

严格按以下顺序推进，避免并行铺开后没有可运行链路：

1. 完成阶段 0 的迁移基线固化和根目录基础 CI。
2. 建立可独立构建、运行和观测的 Control Plane 最小骨架。
3. 冻结 ActorContext、业务错误、Provider Ports、OpenAPI 和统一 SSE Event Envelope。
4. 建立 PostgreSQL 持久化、Plugin Backend 薄代理和生成式 Resource Client。
5. 完成 Dagu Playbook 与 `mcp.call` 垂直链路。
6. 部署 Grafana 官方只读 MCP，再按审批边界增加最小写实例。
7. 接入 Codex，随后实现最小 OpenCode Adapter 做可替换验证。
8. 收口 Workbench、Playbook、Approvals、Alerts 和 Audit 的真实 Gateway。
9. 最后部署 RAGFlow，完成 Knowledge Adapter、Knowledge MCP 和 Knowledge 前端。
10. 完成包含知识检索的黄金 E2E 场景。
11. 再进入告警沉淀、Playbook 生成和代码分析等产品功能。
