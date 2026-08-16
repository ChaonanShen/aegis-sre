# Aegis SRE 详细实施计划

## 1. 计划目标

以已迁移的 Grafana Plugin Frontend 为产品入口，逐步完成以下可替换架构：

- Codex 为默认 Agent，OpenCode 为可替换实现。
- Knowledge Provider 负责知识解析与检索；目标态只支持 RAGLite，RAGFlow 仅在退出窗口内保留只读或回退能力。
- Dagu 为 Playbook 定义和运行引擎。
- Dagu 支持经过白名单约束的 `mcp.call` 自定义 Action。
- Grafana 官方 MCP、Aegis Knowledge MCP、Dagu MCP 同时供 Agent 使用。
- 不复活旧 Agent、RAG、Playbook 或 Grafana Tool 自研实现。

实施采用“契约先行、垂直切片、能力显式启用”的顺序：先完成仓库基线、Control Plane
最小骨架和公共契约冻结，再逐个接入 Provider。未完成真实接入的能力不得注册到 Agent，
也不得在真实模式中回退到 fixture。

Knowledge Provider 依赖和资源开销较大，放在 Dagu 与 Grafana MCP 基本链路稳定之后接入，但优先于 Agent 会话和 Canvas 增强。
Knowledge 的公共接口仍先行冻结；完成真实检索与授权验收后保留 MCP 能力，待 Agent 接入时再注册给 Codex/OpenCode。

Knowledge 产品契约、RAGLite sidecar 收敛、RAGFlow 退出和发布门槛详见
[Knowledge 产品契约收敛与 RAGLite 单 Provider 执行计划](knowledge-product-contract-execution-plan.md)。

Grafana Folder RBAC、Knowledge/Playbook/Agent 的资源归属、MCP 用户委托、审批和迁移顺序详见
[统一权限实施计划](authorization-implementation-plan.md)。该计划是跨模块权限改动的执行门禁；与本文阶段顺序
冲突时，先满足其中的 ADR、fail-closed 和真实权限验收要求。

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
- [x] 明确 Provider 类型、内部 ID 和 SDK 类型只存在于 adapter，不进入普通前端响应。
- [x] 定义能力发现机制；未接入的 Knowledge、Playbook 或 Agent 能力返回稳定的 `capability_unavailable`。
- [x] 生成 OpenAPI client 和事件类型，禁止前后端手写重复 DTO。
- [x] 加入 Provider contract fake，只用于接口测试，不作为真实运行模式的 fixture 或静默 fallback。

验收标准：

- API 类型、领域类型和 Provider SDK 类型彼此分离。
- OpenAPI 与 Event Schema 有兼容性检查，破坏性变更必须显式升级版本。
- Provider ID、凭据和私有错误不出现在公开 Schema。
- 任意 Provider 超时都映射为稳定业务错误。
- 公共契约携带幂等键；具体去重保证必须由对应 Provider 的原生能力或调用方生成的稳定操作 ID 验证。
- 单元测试不需要启动 RAGFlow、Dagu、Agent 或 Grafana MCP。

## 6. 阶段 3：Control Plane 与 Plugin Gateway

状态：**已完成。Plugin Gateway 已接入无状态 Control Plane；本阶段曾误引入的持久化已在后续纠正阶段移除。**

目标：让 Grafana Plugin 通过薄 Plugin Backend 访问冻结后的 Control Plane 契约，为后续 Provider 垂直切片建立唯一入口。

任务：

- [x] Plugin Backend 从 Grafana PluginContext 提取受信的用户、Org 和请求上下文。
- [x] Plugin Backend 只做 REST/SSE 透明代理、超时和受控错误转发。
- [x] 移除 Plugin Backend 对旧仓库 `../api` 的构建依赖。
- [x] 前端 Resource Client 只根据 OpenAPI 和 Event Schema 生成或适配。
- [x] 为 REST、SSE、身份伪造、请求取消和错误净化建立契约测试。

验收标准：

- Grafana 浏览器只访问 Grafana Resource API，不知道 Control Plane 地址和服务凭据。
- Plugin Backend 不包含 Agent 编排、知识检索或 Playbook 运行逻辑。
- 未接入的产品能力在真实模式下明确不可用，不读取 fixture。

## 纠正阶段：移除过早引入的 PostgreSQL 持久化

状态：**已完成。**

背景：阶段 3 沿用了迁移前项目以 PostgreSQL 保存产品元数据、业务 ID 与 Provider ID 映射的假设，但该假设没有先经过 Codex/OpenCode、Dagu、RAGFlow 和 Grafana 原生能力验证。当前 PostgreSQL repository 也未接入 Control Plane 的真实运行路径。继续保留会造成事实来源重复、无消费者抽象和不必要的部署依赖，因此需要在接入首个 Provider 前纠正。

纠正原则：

- Agent 会话、回合、审批和历史由 Agent Provider 持久化。
- Playbook 定义、Run、Step、Human Task、审批、日志和 Artifact 由 Dagu 持久化。
- Knowledge Base、Document、索引任务、Passage、Embedding 和索引由 RAGLite sidecar 持久化。
- Grafana Folder、权限和可由 Grafana 表达的标签、关联优先复用 Grafana 原生能力。
- Control Plane 保持无状态的协议归一化、授权收敛和 Provider 适配层，不建立上述运行数据的影子表或摘要索引。
- 稳定公共 ID、Provider ID 隔离和幂等仍是契约约束，但不得预设通过 PostgreSQL 实现。每个 Provider 垂直切片应先验证调用方生成 ID、原生 metadata/tag、确定性命名和原生幂等能力。
- 如果某个已验证的产品自有状态确实无法由现有引擎承载，必须先提交 ADR，说明数据所有权、不可替代性、生命周期、恢复方式和最小存储范围，再决定是否增加持久化组件。

代码清理：

- [x] 删除 `migrations/` 中尚未形成生产数据的 Control Plane PostgreSQL migration。
- [x] 删除 `internal/adapters/postgres`、数据库 repository 测试和只为这些实现存在的辅助代码。
- [x] 删除无真实消费者的 `SessionRepository`、`ProviderMappingRepository`、`IdempotencyRepository` 及其数据结构；保留 Provider ports 和 Provider-neutral domain contract。
- [x] 删除 `pgx`、`pgxmock`、Goose 等仅为 Control Plane PostgreSQL 引入的依赖和命令，并运行 `go mod tidy`。
- [x] 删除 `AEGIS_DATABASE_URL`、database capability、readiness 数据库状态及其他未使用配置。
- [x] 删除根 CI 中的 PostgreSQL service、migration 步骤和对应 Makefile target，确保 CI 不再启动数据库。
- [x] 检查 `api/openapi.yaml`、Event Schema、domain model 和前端生成类型，移除只为影子持久化设计且尚无 Provider 语义依据的字段；兼容性不确定的公共字段先记录审计结论，不盲目破坏已冻结契约。

Provider 数据归属与标识策略复核：

- [x] Session 的 list/read/resume/archive/delete 直接委托 Agent Provider，不读取 Aegis Session 表。
- [x] Playbook 与 Run 使用 Dagu 原生标识、调用方可控标识或原生 metadata；不建立 Playbook/Run 映射表和状态摘要表。
- [x] KnowledgeBase 与 Document 使用选定 Provider 的原生资源及 metadata 能力；不建立 Dataset/Document 影子表。
- [x] Approval resolve 委托产生 Approval 的 Agent 或 Dagu，不建立 `approval_refs`。
- [x] trace ID 通过请求上下文、结构化日志和后续可观测性链路传递，不作为关系数据库记录保存。
- [x] 幂等优先使用 Provider 原生机制或调用方生成的稳定操作 ID；没有可靠幂等能力时不得用内存或 mock 静默冒充生产保证，应在对应 Provider 阶段明确暴露限制。
- [x] 对无法在不泄漏 Provider ID 的前提下实现稳定公共 ID 的 Provider，暂停该垂直切片并提交 ADR；不得为了预想的可替换性恢复通用映射数据库。
- [x] 复核 `ServiceEntry` 是否仍是独立产品实体；当前只允许从 Grafana 资源派生和只读查询，已从公共契约删除 Aegis 自有创建接口。若 Grafana 无法表达必要状态，再单独决策。

公共契约审计结论：当前 v1 OpenAPI 删除了尚无 Provider 语义依据的统一整数 `version` 字段，以及会迫使 Aegis 成为服务目录事实来源的 `POST /services`。`BusinessID`、时间戳和 `Idempotency-Key` 仍是 Provider-neutral 的协议约束，分别由调用方或 adapter、Provider 原生时间信息、Provider 原生幂等能力承载。统一事件 Schema 不依赖数据库，因此无需修改。迁移来源的 fixture 模型及 `pluginBackend.ts` 兼容契约仍包含其自身的版本字段；它们不属于 Control Plane v1 契约，按兼容窗口保留，待对应模块接入真实 Provider 时另行迁移。

文档清理：

- [x] 更新 `docs/architecture.md`，移除 PostgreSQL 拓扑、持久化模型和影子数据归属，明确 Control Plane 默认无状态及各引擎唯一事实来源。
- [x] 回写本实施计划中阶段 2、阶段 3 及后续阶段受影响的任务和验收项，包括持久化映射、全局数据库幂等、Provider ID 映射和 PostgreSQL 备份演练。
- [x] 更新根 `README.md` 的仓库结构、依赖要求、启动命令和当前阶段说明。
- [x] 审计 `docs/migration-notes.md`，确保迁移边界没有暗示继续保留旧项目数据库。
- [x] 将 `docs/research/knowledge-base-replacement-research.md` 中 Torchbearing PostgreSQL 方案明确标记为历史调研和已废弃结论；保留有价值的 Provider 调研事实，但不得继续充当当前规范。
- [x] 全仓搜索 PostgreSQL、repository、产品元数据、映射表和备份恢复等表述；规范性文档不得残留数据库前提，历史文档中的残留必须带有明确的废弃上下文。

建议按以下小步提交执行：

1. 先提交架构和实施计划纠正，冻结新的数据归属边界。
2. 再提交 PostgreSQL 代码、依赖、配置和 CI 清理。
3. 最后提交公共契约审计结果与其余文档清理；若契约需要破坏性修改，单独提交并说明版本影响。

验收标准：

- Control Plane 和 Grafana Plugin 的开发、测试、构建、启动均不要求 PostgreSQL。
- 仓库中不存在未被真实 Application Service 消费的 repository 接口或实现。
- Agent、Playbook、Knowledge 的状态查询均计划从对应 Provider 获取，不存在第二事实来源。
- 非历史文档、CI、Makefile、配置和发布拓扑中不再出现 PostgreSQL 依赖。
- Provider ID 不进入前端公共契约；同时不以预建通用映射表规避具体 Provider 的标识能力验证。
- `make verify`、契约生成一致性检查、Go test/vet/build、Plugin Backend 测试及前端 typecheck/lint/Jest/Webpack 全部通过。
- 阶段 4 的 Dagu 垂直链路按原阶段编号继续推进。

## 7. 阶段 4：Dagu 与 `mcp.call`

状态：**基本执行链及 Run 实时状态闭环已完成。插件可直接启动、查看和取消 Dagu Run，并展示 Step 状态；完整运行观测与交互仍需在阶段 7 和后续高级运行观测阶段收口。**

目标：Dagu 成为 Playbook 唯一执行引擎，插件不再依赖自定义 DSL。

### 4.1 迁入实验成果

从 `/Users/a1111/proj/codex-playbook-dagu` 迁入并整理：

- [x] Dagu REST client 和 API 类型。
- [x] 原生 YAML 解析与前端 DAG 映射。
- [ ] Run、Step、日志、Artifact 查询（Run、Step、Artifact 已完成，日志待补）。
- [x] `human.task` 表单提交。
- [x] Approval approve/reject/rewind。
- [x] `mcp.call` Runner、配置和验收用例。

迁入时不得复制实验用 Prometheus MCP 实现，正式环境直接使用 Grafana 官方 MCP。

### 4.2 Playbook Provider

- [x] YAML CRUD 和服务端 validate。
- [x] Run、enqueue、cancel、retry。
- [x] Run/Step 状态映射和事件轮询。
- [x] Human Task 与 Approval 统一映射。
- [x] Artifact 列表、预览和下载代理。
- [x] 验证调用方生成 DAG/Run ID、Dagu 原生名称或 metadata 的公共标识策略，不建立映射表。
- [x] GitOps 与 UI 写入冲突策略 ADR。

### 4.3 `mcp.call` 生产化

- [x] Server 和 Tool 双重 allowlist。
- [x] 连接、握手、调用和总超时。
- [x] 最大文本、结构化内容和二进制结果限制。
- [x] Bearer Token file、CA 和可选 mTLS。
- [x] Text、Image、Audio、ResourceLink 和 Embedded Resource 归一化。
- [x] 大结果进入 Dagu Artifact，只在 Step 输出中返回摘要和路径。
- [x] 为写操作传递幂等键和 trace ID。
- [x] 禁止调用 Dagu 自身执行类工具形成递归。
- [x] Write Tool 默认拒绝，逐项评审加入。
- [x] 本地 Prometheus/node-exporter 监控通过 Grafana datasource 和 `grafana-read` MCP 接入；Playbook 不直连 Prometheus。
- [x] 提供带 `depends` 的 Node Health DAG：并行查询可用性、CPU idle、可用内存，汇总为 Artifact。

本阶段使用只实现允许工具的 MCP contract server 验证 `mcp.call` 协议、限制和 Artifact；
不得迁入实验用 Prometheus MCP。对 Grafana 官方 MCP 的真实调用在阶段 5 补充验收。

### 4.4 前端接入

- [x] Grafana Plugin 经 Plugin Backend、Control Plane 到 Dagu 完成 Playbook CRUD 与真实 E2E。
- [x] 使用原生 Dagu YAML 作为编辑内容和事实来源。
- [x] 迁移 Playbook DAG 可视化，不反向生成第二套 DSL。
- [x] 实现真实 `PlaybookGateway`。
- [x] 展示 Run、Step、Human Task、Approval 和 Artifact（日志展示仍待补稳定契约）。
- [x] 删除真实模式下的 Playbook fixture fallback。
- [x] 通过真实 Dagu Run 验证多个 `mcp.call` 查询节点和汇总 Artifact。
- [x] 历史 Run 不阻止再次执行；`run.updated` 作为快照失效通知驱动完整 Run 刷新，终态无需手动刷新页面。
- [x] 新 Run 使用原生 Dagu YAML 的 `name` 展示在 Dagu executions；Aegis 通过 adapter 私有标签保留稳定 Playbook 关联，并兼容旧的 `pbk_*` Run 名称。

### 4.5 2026-08-15 Playbook 链路修正记录

已完成：

- [x] `run.updated` 不再只发送 `status`，Dagu adapter 改为发送包含 Run ID、Playbook ID、状态、序号、时间和 Step 的完整公共快照；流正常结束但未收到终态时，前端使用 `getRun` 做最终对账（`2c4c65c`）。
- [x] Run 列表接通不透明 cursor 分页；`has_more=true` 时保证返回 `next_cursor`，前端可连续加载全部页（`dcebe0a`）。
- [x] Artifact 下载 URL 补齐 Grafana Plugin Resource 前缀；切换或启动 Run 时清理旧 Artifact，列表加载错误不再静默吞掉（`1bd5ff7`）。

仍待修正：

- [ ] SSE `sequence` 当前仍是单连接内轮询序号，不是 Provider 可持久恢复的序号；断线后必须通过 Run 快照对账，并明确重复事件和 cursor 失效语义，不建立 Aegis Event Store。
- [ ] Run/Step 公共详情仍缺少 Provider-neutral 的输出、错误、可空耗时、参数、发起人、retry 关系和日志引用；不得把 Dagu 私有结构直接暴露给前端。
- [ ] 未识别的 Dagu Run/Step 状态目前可能被映射成看似有效的状态；无效时间也可能被 REST 投影成当前时间。应改为明确 Provider 结果错误或可空的 unknown 语义，不能生成误导数据。
- [ ] Artifact 仍主要跟随最新终态 Run 展示；需要支持选择历史 Run、文本预览、截断、媒体类型、权限错误、过期引用和下载重试。

本轮保证 Playbook 可以从 Grafana 插件执行并处理人工交互；不把 Dagu UI 当作最终产品界面。日志展示仍因缺少稳定的 provider-neutral API 暂缓，不能把 Provider 私有日志协议直接泄漏到前端。

Dagu 2.13.0 没有重命名历史 DAG Run 的稳定接口，因此 Playbook 改名只影响之后创建的新 execution；已有 execution 保留当时的名称，但仍通过兼容查询出现在同一 Playbook 的运行记录中。

验收标准：

- CRUD、validate、run、cancel、retry 可用。
- Human Task 和 Approval 暂停后可以从插件恢复运行。
- 四个并行 `mcp.call` 节点能通过 contract server 稳定完成并生成报告 Artifact。
- 未在 allowlist 中的工具在连接前或调用前被明确拒绝。
- Dagu 重启后仍能读取既有 DAG 和运行记录。

## 8. 阶段 5：Grafana 官方 MCP

状态：**本地可复现的只读部署、调用方鉴权网关和真实 Dagu 调用验收已完成；生产 TLS 与写实例验收仍待完成。**

目标：完全替代自研 Grafana/Prometheus MCP 工具。

任务：

- [x] 固定 `grafana/mcp-grafana` 版本和多平台镜像 digest。
- [x] 部署 `grafana-read`，强制 `--disable-write`。
- [x] 只启用当前产品需要的工具类别。
- [x] 通过薄鉴权网关校验调用方 Bearer Token；官方 v1.0.0 后端保持内部不可直达。
- [ ] 设置 allowed hosts/origins 和 TLS 或可信反向代理（本地 Host/网络边界与鉴权网关已完成；生产 TLS 待部署环境验收）。
- [x] 使用文件挂载 Service Account Token，支持轮换。
- [x] 按需部署 `grafana-write`，使用独立低权限账号。
- [x] 发布供后续 Codex、OpenCode 和 `mcp.call` 消费的版本化连接配置。
- [x] 为常用 PromQL、LogQL、告警和 Dashboard 工具建立显式真实冒烟命令。
- [x] 使用阶段 4 的 `mcp.call` Runner 对 `grafana-read` 完成真实调用并验证 Artifact。

补充完成项：根 Compose 会创建低权限 Viewer Service Account，凭据通过共享文件交给 Grafana MCP；Dagu REST 启用独立 Basic Auth；Grafana MCP 与鉴权网关均不发布主机端口；CI 运行四并行节点的 Dagu `mcp.call` 合同测试。生产环境仍需把本地文件凭据替换为 Secret Manager，并补齐 TLS、NetworkPolicy、轮换/吊销演练。

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

状态：**执行中。默认链路已冻结为 Grafana Read + Aegis Playbook MCP；Knowledge Provider 代码保留但默认 disabled。OpenCode + DeepSeek 的本地核心会话闭环已完成真实冒烟；Playbook MCP facade、真实 Run 控制和组合冒烟入口已接入。OpenCode unarchive/approval 按 ADR 0006 明确不接入，Workbench 旧 Session 持久化抽象清理和 Codex/OpenCode 合同验收仍待完成。**

目标：Codex 作为默认 Provider，同时用 OpenCode 证明抽象没有泄漏。Grafana 插件的 Workbench 是唯一会话入口，不增加 Codex 或 OpenCode 独立聊天页面。Session、Turn、消息、审批和历史全部由 Agent Provider 持久化；Aegis 只提供无状态的公共契约、授权收敛、进程监管和协议适配。

### 6.0 单一会话入口与实现顺序

- [x] 前端只使用 Aegis `Session / Turn / Event` 公共契约，不直接连接 Codex App Server、OpenCode Server 或解释其私有事件；公共契约是防腐层和 Provider 数据投影，不是 Aegis 持久化模型。
- [x] 首个版本使用部署级 `AGENT_PROVIDER=codex|opencode`，同一 Control Plane 实例只装配一个 Agent Provider；不引入逐 Session Provider 选择和映射表。
- [x] Codex 使用由 Control Plane 监管的长期运行 App Server，通过 `stdio + JSONL` 双向 JSON-RPC 管理 Thread、Turn、审批和流事件；进程监管只负责生命周期和重连，不得为每条消息临时执行 CLI 命令，也不得接管会话存储。
- [x] OpenCode 使用长期运行的 Server HTTP API 与 SSE；SDK 只作为可选生成客户端，不为使用 SDK 额外引入 Node 中间服务。
- [x] Aegis 公共 Session ID 保持 Provider-neutral；Codex Thread ID、OpenCode Session ID 和 Provider 类型只存在于 adapter 内部。
- [x] 切换部署级 Provider 时使用新的会话空间，不承诺把同一底层会话在 Codex 与 OpenCode 之间无损迁移；以后如需同实例并存，必须先提交无状态路由 ADR。
- [ ] Session list/read/resume/rename/archive/delete 直接调用 Provider 原生 API；不得增加 `SessionRepository`、消息表、事件表、Checkpoint、Provider 映射表或前端整会话保存接口。
- [x] 前端发送 Turn 时只提交本次输入、受信上下文和操作 ID，不回传完整消息历史；历史从 Provider 的 Thread/Session 读取。
- [x] 在多用户模式启用前，验证按 Tenant、Org、User 或明确产品范围隔离 Provider 会话命名空间；首版已按 ADR 0003 fail-closed 到唯一受信 Actor，多用户仍保持禁用。
- [x] `FolderUID` 默认只作为请求时授权上下文；公共字段已标记 deprecated，Codex/OpenCode 均不持久化该值，也未建立映射。

首版按 ADR 0003 绑定唯一受信 Tenant、Org 和 User；不匹配的 Actor 必须 fail-closed。该模式只用于
形成可验收的单 Actor Provider 会话空间，不代表多用户 private Session 已经完成。Provider 原生
隔离或按 Actor 确定性隔离的进程与数据目录完成前，不得开启多用户 Agent 能力。

本阶段优先完成会话本身：create/list/read/resume/rename/archive/delete、Turn 流、取消、审批、错误恢复和 Provider 重启恢复。所有恢复都从 Provider 的持久化数据执行，不从 Aegis 数据库恢复。图表、图片与 Canvas 的生成、恢复和编辑不作为会话首轮接入的阻塞条件；Canvas 是独立产品投影，不得借其持久化需求重新引入整套 Session 存储。

### 6.1 Codex Adapter

- [x] 固定 Codex CLI/App Server 版本，并提交版本化 JSON Schema。
- [x] 由 Control Plane 管理持久 `stdio + JSONL` 子进程。
- [x] 完成 initialize/initialized 握手。
- [x] 直接适配 `thread/start/list/read/resume/name/set/archive/unarchive/delete`；列表、详情、消息历史和归档状态均从 Codex 持久化数据读取。
- [x] 实现 turn start/interrupt。
- [x] 映射 message delta、MCP call、命令、文件变更、完成和失败事件。
- [x] 处理命令和文件变更审批请求；未识别的 App Server 请求 fail-closed。
- [ ] 启动时校验当前声明启用的 Grafana 和 Dagu MCP；Knowledge 未接入前不得注册虚假工具。
- [x] 验证 Codex Thread 的公共标识策略，不保存 Session/Thread 映射表。
- [x] 使用生成的版本化 JSON Schema 做协议兼容测试。
- [x] Control Plane 镜像内置固定版 Codex，并将 `CODEX_HOME` 声明为独立持久卷；生产备份恢复演练仍待真实环境验收。
- [x] 明确 Codex `thread/start` 和 `turn/start` 不提供客户端幂等键时的限制：响应不确定后返回不可重试的 `provider_result_unknown`，不自动重提。

### 6.2 OpenCode Adapter

- [x] 固定 OpenCode 版本。
- [x] 实现带可轮换 Basic Auth、响应上限和错误净化的 HTTP client。
- [x] 实现底层 session create/read/delete/abort 和 caller-supplied ID。
- [x] 实现 async prompt 和 durable SSE event 订阅。
- [ ] 映射 message part、tool call、permission 和完成事件（message/tool/完成已接通；固定版 durable SSE 不包含 permission 事件，审批续流待解决）。
- [ ] 配置与 Codex 一致的完整 MCP 清单（Knowledge 已在可选部署中完成鉴权注册；Dagu 与 Grafana 清单统一仍待完成）。
- [ ] Session list/read/update/delete 和消息历史直接使用 OpenCode 原生 API，并为 OpenCode 数据目录配置官方持久化与备份恢复；Control Plane 不保存副本。

### 6.3 Provider 合同测试

同一套测试必须对 Codex 和 OpenCode 执行：

- [ ] 创建、读取和删除会话。
- [ ] 发送消息并按序收到增量事件。
- [ ] 调用当前已启用的 Grafana 和 Dagu MCP 工具。
- [ ] 拒绝和接受审批。
- [ ] 中断运行中的 Turn。
- [ ] Provider 重启后从其原生持久化恢复会话，Control Plane 无本地 Session/Turn 数据仍可工作。
- [ ] 对支持原生幂等的 Provider 验证重复请求不创建重复 Turn；不支持时验证响应不确定后不会自动重提，并在公共错误中明确能力限制。
- [ ] 浏览器或 Control Plane 断线后重新读取 Provider 会话快照；Provider 不支持精确 delta 重放时明确终止旧流，不建立 Aegis Event Store。

验收标准：切换部署级 `AGENT_PROVIDER=codex|opencode` 后，插件请求和事件 Schema 不变化；清空或重启 Control Plane 不丢失会话，删除 Provider 持久卷则按 Provider 自身的数据丢失语义处理。

### 6.4 2026-08-15 会话链路修正记录

已完成：

- [x] OpenCode V1 全局事件按顶层 Session、嵌套 `info.sessionID`、`part.sessionID`、Message 所属关系做 fail-closed 隔离；无法证明归属或属于其他 Session 的事件不会进入当前 Turn（`092fda2`）。
- [x] Codex/OpenCode 缺少真实工具耗时时，公共 `duration_ms` 返回 `null`，不再伪造 `0`（`50827b9`）。
- [x] Session 公共摘要增加可空 `message_count` 和 `preview`；Codex 从原生 Thread 投影真实值，Provider 无法在列表接口证明时返回 `null`，前端显示“消息数未知”而不是错误的 `0 条消息`（`0bffd2a`）。
- [x] 前端 Session 列表接通全部 cursor 页，并在 `has_more` 缺少 `next_cursor` 时显式报错（`ddb2650`）。
- [x] Turn 终态对账合并 Provider 持久化文本与实时工具卡，避免本次流中已确认的工具调用和结果被文本历史覆盖（`1540f46`）。
- [x] OpenCode pending 工具事件参数为空时，running 阶段的完整参数会继续投影；前端按稳定 call ID 原位更新工具卡，不重复插入（`f481af7`）。
- [x] OpenCode completed/error 中的输出和结构化错误进入 Provider-neutral `summary`，工具卡不再只有成功/失败状态（`a7ff510`）。

仍待修正：

- [ ] 公共 Message 历史仍以纯文本为主，尚未冻结 Provider-neutral 的 parts/tool contract。需要支持 text、tool call、tool result、error、call ID、来源（MCP/builtin/runtime）、参数、结果、状态、可空耗时和时间戳。
- [ ] Codex 历史读取目前主要保留 `userMessage`/`agentMessage` 文本；OpenCode 历史读取也主要保留 text part。刷新或重新打开旧 Session 时，历史工具卡、工具结果和错误仍不能完整恢复。
- [ ] 当前终态合并只保护本次浏览器已收到的实时工具卡，不能代替 Provider 历史投影；不得通过 Aegis 消息表或前端整会话缓存补齐。
- [ ] OpenCode 工具来源仍可能退化为通用 `agent` 命名空间，需要从固定 Provider 协议可靠区分 MCP、内置工具和 runtime；无法证明时使用明确 unknown，不猜测 Grafana/Dagu 来源。
- [ ] OpenCode Session 列表接口无法直接给出可信消息数时当前返回 `null`；后续仅在 Provider 有批量统计能力或可接受的受控查询方案下接通真实统计，禁止无界 N+1 扫描。
- [ ] 仍需补双 Provider 历史恢复合同测试：工具调用、工具结果、错误、未知耗时、重启恢复和刷新恢复必须保持相同公共 Schema。

## 10. 阶段 7：核心前端真实模式收口

状态：**执行中。真实模式 fallback 已收口，Playbook 已接 Dagu；真实 Run 参数、SSE、retry、Human Task、Approval、Artifact 已接入 gateway，组合 Agent + Playbook E2E 已提供入口。Workbench 会话完整能力、Alerts、Audit 和真实环境验收仍待完成。**

目标：先收口不依赖 Knowledge Provider 的真实功能；Knowledge 页面保持明确不可用，直到阶段 8 的 Provider 迁移垂直切片完成。

任务：

- [x] 生成或实现 Control Plane Resource Client。
- [x] Workbench 使用统一 Agent Event，不再识别旧 AgentType。
- [x] Session 列表加载全部 cursor 页；消息统计未知时不再显示为 `0 条消息`。
- [x] Turn 完成后的 Provider 快照对账保留实时工具卡、结果和完整 running 参数。
- [ ] Workbench 真实会话支持完整的 create/list/read/resume/rename/archive/unarchive/delete、流式 Turn、取消和 Agent Approval；此项优先于 Canvas 增强。
- [ ] 删除迁移遗留的 `saveSession`、前端 `persistenceQueue` 和发送完整 `history` 的真实模式抽象；前端可以乐观渲染，但最终会话与消息必须重新从 Agent Provider 读取。
- [ ] 审计公共 `Session` 的 `folder_uid`、title、status 和时间字段，只保留 Provider 原生可读写或可可靠派生的字段；不支持的持久字段通过显式契约修订移除，不以数据库补齐。
- [x] Playbook 使用 Dagu-backed API。
- [x] Playbook 在 Grafana 插件内完成参数、retry、SSE、Human Task、Approval 和 Artifact 的运行闭环；不得要求用户跳转 Dagu UI 才能判断执行结果。
- [ ] Approvals 汇总 Agent Approval 与 Dagu Approval。
- [ ] Alerts 接入真实 Grafana 告警上下文。
- [ ] Audit 页面接入跨 Provider trace 和操作摘要。
- [x] fixture 仅在显式 fixture/test 模式启用。
- [x] 真实模式中未实现能力显示明确不可用，不静默返回 fixture 数据。
- [x] 增加 `make agent-playbook-e2e` 真实组合冒烟入口；Playwright 视觉验收仍待本地完整栈环境执行。

### 7.1 Query-backed Chart 与 Canvas 持久化（会话闭环后实施）

状态：**核心实现已完成，真实环境验收仍待执行。** 当前真实 Workbench 已支持临时链路：成功的 Grafana
`query_prometheus` range 调用会在浏览器侧投影为 Chart Definition，插件通过 Grafana
DataSourceApi 查询并用原生 PanelRenderer 绘制；刷新后该临时投影会丢失。

本切片的事实来源边界如下：

- Agent Provider 继续独占 Session、Turn、Message、工具调用和审批的持久化；Aegis 不增加
  `SessionRepository`、Turn/Message/Event 表或 Provider ID 映射。
- Aegis 独占产品专有的 Canvas 投影：持久化 Query Definition、Chart Definition、Canvas
  布局/成员/active chart 和乐观并发版本。记录以 Provider-neutral 的公开 Session ID 和可信
  Actor scope 关联 Agent 会话，但不复制会话字段，也不把 Canvas 记录伪装成 Agent Session。
- 首版 Query 只保存 datasource UID、PromQL、绝对时间范围和 step；Chart 只保存标题、类型、
  VizConfig、Query 引用和可选来源引用；Canvas 只保存布局和 Chart 位置。不得保存查询样本、
  Grafana 响应、工具结果正文或图表截图。重新打开会话时必须重新查询当前 Grafana 数据源。
- 普通 PNG/JPEG/SVG 等二进制 Artifact 不与 Query-backed Chart 共用持久化模型，继续按 9.2
  的受控 Artifact 引用设计实施，不作为本切片的阻塞项。

#### 7.1.1 阶段 0：冻结 ADR 与边界

- [x] 新增 `docs/adr/0007-canvas-sqlite-persistence.md` 并同步更新 `docs/architecture.md` 的组件、
  数据归属、持久化决策门和部署拓扑。ADR 必须明确 SQLite 是 Aegis Canvas 投影的唯一事实来源，
  Agent Provider 仍是 Session/Turn/Message 的唯一事实来源。
- [x] 冻结首版范围为 Prometheus range Query-backed Chart；instant 查询、LogQL、普通图片、跨 Session
  Canvas、模板市场、多人实时协作和 Chart 查询编辑不进入本切片。
- [x] 明确只借鉴旧项目的 Query/Chart/Canvas 拆分、绝对时间、事务和乐观版本；不得迁移旧项目的
  `sessions`/`turns` 表、Agent Runner、Prometheus Runner、自研 Grafana MCP 或整会话 Store。
- [x] ADR 记录 SQLite 的单 Control Plane 实例/单写者限制；多副本和网络文件系统不在首版支持范围。
  以后需要水平扩展时更换 Canvas Store adapter，不改变领域 Port 和公共 API。

完成门禁：ADR 接受后才能增加数据库依赖或跨模块装配。

#### 7.1.2 阶段 1：SQLite 基础设施与部署

- [x] 固定纯 Go 驱动 `modernc.org/sqlite v1.56.0`，保持现有 `CGO_ENABLED=0` 构建；不引入 ORM。
- [x] 增加显式配置：`AEGIS_CANVAS_ENABLED`、`AEGIS_CANVAS_DB_PATH` 和
  `AEGIS_CANVAS_MCP_TOKEN_FILE`。启用时 DB path 必须是绝对路径、父目录可写、Token 必须是只读
  普通文件；缺少或错误配置时启动失败。未启用时能力明确返回 unavailable，不使用内存或 fixture
  回退。开发默认路径为 `/var/lib/aegis/canvas/canvas.db`；capabilities 和 readiness 增加独立
  `canvas` 状态，不能用 Agent available 掩盖 Canvas Store 不可用。
- [x] `compose.yaml` 为 Control Plane 增加 `control-plane-data` named volume，只将
  `/var/lib/aegis/canvas` 设为可写，继续保持容器根文件系统 `read_only: true`；镜像创建目录并保证
  运行用户可写。Canvas MCP 使用独立 secret，不复用 Plugin、Grafana MCP 或 Playbook MCP Token。
- [x] 打开数据库后固定执行并校验 `foreign_keys=ON`、`journal_mode=WAL`、`synchronous=FULL`、
  `busy_timeout=5000`；连接池 `MaxOpenConns=1`、`MaxIdleConns=1`，所有写入使用显式事务。
- [x] 迁移 SQL 使用 `go:embed` 随二进制发布，建立带 checksum 的 `schema_migrations`。启动时在提供
  HTTP 服务前串行迁移；未知新版本、checksum 漂移或迁移失败必须 fail-closed，不得跳过迁移继续
  运行。数据库目录权限目标为 `0700`、文件为 `0600`。
- [x] readiness 增加 SQLite `SELECT 1` 和当前 migration version 检查；关闭时停止接收新写请求、
  等待事务完成、执行受限 WAL checkpoint 并关闭连接。
- [x] 提供运维文档和脚本：备份使用 SQLite backup API 或停写后的 checkpoint + 一致快照，不允许只
  复制运行中的主 `.db` 文件而遗漏 `-wal/-shm`；恢复必须在临时目录完成 `integrity_check` 后原子替换。
  首版迁移只前进，回滚使用上一版本二进制兼容窗口加数据库备份恢复。

完成门禁：空库启动、重复启动、升级迁移、损坏库拒绝启动、Compose 重启恢复和备份恢复测试通过。

#### 7.1.3 阶段 2：最小数据模型与 Canvas Store Port

SQLite 只包含下列 Canvas 聚合数据，不建立 `sessions`、`turns`、`messages`、`events` 或 Provider
映射表：

| 表 | 主键/唯一约束 | 保存内容 |
| --- | --- | --- |
| `schema_migrations` | `version` | migration checksum 与应用时间 |
| `canvases` | `(tenant_id, org_id, user_id, session_id)` | `layout`、`visible`、`active_chart_id`、`revision`、创建/更新时间 |
| `queries` | Actor scope + `session_id/query_id/version` | `language=promql`、datasource UID、expression、绝对 `from/to`、step、创建时间 |
| `charts` | Actor scope + `session_id/chart_id`；同 Session 内 `publish_operation_id` 唯一 | Query/version 引用、title、description、visualization、规范化 VizConfig、request hash、revision、创建/更新时间 |
| `canvas_items` | Actor scope + `session_id/chart_id`；`position` 唯一 | Canvas 成员和当前 UI 使用的稳定排序 |

- [x] 数据库外键只连接上述产品投影内部记录；`session_id` 是经过校验的公开 Session 引用，不对
  不存在的 Aegis Session 表建立外键。所有查询条件必须包含完整可信 Actor scope 和 Session ID。
- [x] 在 `internal/ports` 增加独立 `CanvasStore`，至少提供 `Get`、`PublishQueryChart`、
  `UpdateLayout`、`Delete` 和 `Check`；在应用层增加 Canvas Service，先通过 `AgentProvider.ReadSession`
  校验会话存在、Actor 有权且状态允许，再调用 Store。Store 本身不依赖 Agent Provider。
- [x] `PublishQueryChart` 在一个 `BEGIN IMMEDIATE` 事务内创建/读取 Canvas、写 immutable Query
  version、写 Chart、追加 Canvas item 并递增 Canvas revision。任何一步失败必须整体回滚。
- [x] 发布请求要求 8-128 字节稳定 idempotency key；保存 canonical request hash。同 key 同 payload
  返回原 Chart 和 revision，同 key 不同 payload 返回 `idempotency_conflict`，不得覆盖已有定义。
- [x] `UpdateLayout` 只接受 `visible/layout/active_chart_id/ordered_chart_ids` 和期望 revision。客户端不能
  修改 Query、VizConfig 或伪造新 Chart ID；成员删除在同一事务中删除 Chart，并删除已无引用的 Query。
  revision 不一致返回 `canvas_revision_conflict` 和当前 revision，不做 last-write-wins。
- [x] 首版上限：每 Canvas 20 个 Chart、datasource UID 512 bytes、PromQL 16 KiB、title 1 KiB、
  description 4 KiB、VizConfig 128 KiB/深度 12/节点 2048；只接受绝对 UTC 且递增的时间范围、正 step、
  最多 31 天范围和最多 11000 个预估数据点。VizConfig 只允许 Dashboard v2 `VizConfig` envelope，
  禁止 targets、原始 frames/series/samples、URL、凭据和任意 HTML。
- [x] ID 使用公共前缀 `qry_`、`cht_`，由服务端生成；时间由服务端 UTC clock 生成。所有 SQLite
  错误映射为稳定领域错误，响应和日志不得包含 DB path、SQL、PromQL 全文或 datasource 凭据。

完成门禁：文件数据库关闭重开后逐字段一致；事务回滚、外键、幂等、并发 revision、Actor 隔离、
资源上限和“不存在样本列/结果 JSON”测试通过。

#### 7.1.4 阶段 3：公共 HTTP 契约

- [x] 在 `api/openapi.yaml` 增加 Provider-neutral 的 `QueryDefinition`、`ChartDefinition`、
  `CanvasProjection`、`CanvasItem` 和 `UpdateCanvasRequest`，运行现有 Go/TypeScript 契约生成器；不得
  直接复活 `pluginBackend.ts` 迁移兼容契约。
- [x] 增加 `GET /api/v1/sessions/{session_id}/canvas`：先用 Agent Provider 验证会话和权限，再读取
  Canvas。尚未创建时返回 `200` 的空投影和 revision 0；Store 故障返回受控 5xx，不能伪装成空投影。
- [x] 增加 `PUT /api/v1/sessions/{session_id}/canvas`：要求 `If-Match`/expected revision，只更新显示、
  布局、active chart 和顺序/删除。返回新 projection 与 ETag；冲突返回 409
  `canvas_revision_conflict`，越权使用 404/403 的现有资源隐藏策略。
- [x] 不把 Canvas 字段塞回 Agent `Session` 领域模型。Workbench Gateway 打开会话时并行读取
  SessionDetail 和 CanvasProjection，在前端应用层组装；任何真实依赖失败都显示对应错误。
- [x] archive/unarchive 保留 Canvas；归档会话可读取但禁止发布和布局编辑。Session delete 成功或
  幂等重试确认 Provider 已不存在后删除 Canvas 聚合；若 DB 删除失败，返回 retryable 错误，重复
  delete 必须继续完成清理。不得增加 Session 影子状态做对账。

完成门禁：OpenAPI 生成物无漂移，HTTP 测试覆盖空投影、刷新读取、revision 冲突、归档、删除重试、
跨 Actor 拒绝和 Store 故障。

#### 7.1.5 阶段 4：Aegis Canvas MCP 与 Agent 工作流

- [x] 在 Control Plane 增加 `/mcp/canvas` 薄 facade 和唯一首版工具
  `canvas.publish_query_chart`。输入只包含公开 Session ID、idempotency key、datasource UID、PromQL、
  绝对时间范围、step、title 和受限 visualization/VizConfig；禁止传查询结果或 Provider ID。
- [x] MCP 使用独立 bearer token，并在服务端绑定配置中的固定 Tenant/Org/User；忽略模型声明的
  Actor。每次发布仍通过 Agent Provider 验证 Session 存在且 active，再调用同一个 Canvas Service，
  不复制持久化逻辑。
- [x] 通过 Provider-neutral 的 Turn context 把当前公开 Session ID 和发布规则提供给 Agent：先调用
  官方 Grafana MCP `query_prometheus` range，只有成功且用户意图需要图表时才调用 Canvas MCP；
  datasource、PromQL 和绝对范围必须与刚成功的查询一致。Codex/OpenCode adapter 只负责各自的
  context 投影，不各自实现 Canvas 协议。
- [x] 把 Canvas MCP 加入 Codex/OpenCode 的固定 MCP 清单和启动合同检查。工具返回稳定结构
  `{chart_id, canvas_revision}`；失败查询、instant 查询、缺少绝对范围或未授权 Session 不得发布。
- [ ] 先用固定 Provider 版本合同测试确认两者都能保留 Canvas MCP 的成功结果。
- [x] 增加 `canvas.updated` 公共事件，payload 只含 Session ID、Chart ID、operation 和 revision；不得透传
  Provider tool result。若实时事件丢失，持久化仍已完成，重新 GET Canvas 必须恢复，不增加 Event Store。
- [x] OpenCode 1.18.18 采用混合协议：V2 仅创建调用方 Session ID，V1 `prompt_async`、MCP 执行和全局
  `/event` 负责 Agent 回合；V1 事件在 Adapter 内转换，不改变 Canvas 或公共 Session 契约。

完成门禁：Codex 与 OpenCode 使用同一 MCP schema 完成“自然语言 -> PromQL -> Grafana 查询成功 ->
发布 Query-backed Chart”，失败路径不产生数据库记录。

#### 7.1.6 阶段 5：Grafana Plugin 恢复与编辑

- [x] 将 Workbench 模型切换到当前 v1 生成契约，移除真实链路对旧 `pluginBackend.ts` Query 类型的
  依赖。保留现有 DataSourceApi + PanelRenderer，不新增截图或样本缓存。
- [x] `openSession` 同时加载 Provider 消息和持久化 Canvas；Chart 使用持久化的 datasource UID、
  PromQL、绝对范围、step 和 VizConfig 重新查询。数据源不存在、失权、超时和查询错误显示可重试
  Chart 级错误，不能删除定义或回退 fixture。
- [x] 收到 `canvas.updated` 后按 revision 重新 GET Canvas，以服务端 projection 覆盖临时 Chart；
  现有 `query_prometheus` 参数解析只保留为流内 optimistic preview，并在持久化 projection 到达后按
  Chart ID/operation 合并，不能成为恢复事实来源。
- [x] 将 `updateCanvas` 改为异步真实写入：本地乐观显示，PUT 成功后采用服务端 projection；409 时
  重新读取并提示用户重试，网络失败回滚到最后确认 revision。真实模式启用布局切换、排序、删除、
  active chart 和显示/隐藏，fixture 模式仍与真实存储完全隔离。
- [ ] 切换 Session、刷新、SSE 中断和组件卸载时取消旧请求；晚到响应必须按 Session ID + revision
  丢弃，不能把前一个 Session 的 Canvas 合并到当前页面。

完成门禁：前端 controller/reducer/gateway/component 测试覆盖恢复、乐观合并、409、晚到响应、
删除、数据源错误和无 fixture fallback。

#### 7.1.7 阶段 6：端到端验收、运维与发布

- [ ] 增加真实 E2E：自然语言请求指标图 -> Agent 生成 PromQL -> 官方 Grafana MCP 查到真实
  Prometheus -> Canvas MCP 发布 -> 插件原生绘图；记录查询前后 SQLite 行数和公共 revision。
- [ ] 验证浏览器刷新、重新打开 Session、Control Plane 容器重启、Agent Provider 重启后均恢复
  同一 Canvas；Datasource 删除/停用时保留定义并显示可恢复错误，恢复 Datasource 后可再次绘制。
- [ ] 验证重复 MCP 调用不重复建图、同 key 异 payload 被拒绝、并发布局编辑返回冲突、跨 Actor
  100% 拒绝、归档只读、删除级联和 DB 不可写/磁盘满时 fail-closed。
- [ ] 增加结构测试直接检查 Schema 和持久化内容，证明没有 Session 消息、工具结果、Prometheus
  samples/series/frames、截图、Provider ID 或凭据；日志测试证明不输出 PromQL 全文和 DB path。
- [x] 暴露低基数指标：Canvas 读写耗时/错误、revision conflict、MCP 发布结果、SQLite busy、migration
  version 和 DB 文件大小；不得把 Session/Chart/Datasource ID 放进 metric label。当前端点提供 Canvas
  操作计数、发布计数、错误、冲突、通知、SQLite busy、migration version、DB 文件大小和累计耗时。
- [x] 更新本地 smoke、部署文档、备份恢复 runbook 和发布说明。先在单实例环境开启
  `AEGIS_CANVAS_ENABLED=true`；回滚前做一致备份，旧二进制不得对新 Schema 执行写入。

最终验收标准：用户不需要打开 Codex/OpenCode 自带 UI；Agent 完成 Grafana 查询并发布 Chart 后，
刷新页面、重新打开会话或重启 Control Plane 都能恢复同一 Canvas 布局和 Chart Definition，插件
会重新查询 Grafana 并绘制。删除 Agent 会话后对应投影按既定策略清理；删除或停用数据源时保留
定义并显示可恢复错误。整个闭环不得新增 Aegis Session/Turn/Message 持久化，也不得保存指标样本。

验收标准：

- 真实模式不读取 fixture store。
- Provider ID 和凭据不出现在浏览器响应、URL 或日志中。
- SSE 断线后优先从 Provider 会话快照恢复最终状态；只有 Provider 支持时才重放精确增量，否则明确终止旧流。
- 页面卸载时会取消不再需要的请求和流。

## 后续阶段：Playbook 日志与高级运行观测

状态：**部分完成，不阻塞当前 Agent → Playbook 主链路。** 基础参数、启动、取消、retry、完整 Run SSE
状态快照、cursor 分页、Human Task、Approval、Artifact 列表和下载已接入；日志展示及 Artifact 文本预览仍待稳定的
provider-neutral 契约。

后续必须完成：

- [x] Human Task 的 JSON 输入、提交幂等和等待状态恢复。
- [x] Approval 的 approve/reject/rewind 和重复提交保护。
- [x] Artifact 列表和下载入口；下载使用完整 Plugin Resource URL，Run 切换会清理旧列表且加载错误可见。文本预览、截断提示和非文本媒体处理待补。
- [ ] Run/Step 日志、SSE 断线重连、大小限制和 Provider 路径净化；先增加稳定端口和 OpenAPI 契约。
- [x] 刷新页面后通过 Run 查询恢复待处理任务、审批和 Artifact 状态。
- Playwright 真实 Grafana + Dagu + Agent 组合验收。

本阶段不得重新引入旧 dry-run gateway，也不得把 Dagu Provider 内部路径暴露到前端领域模型。

### 9.1 运行日志展示（待后续具体实现）

状态：**未开始。** 当前 Control Plane/OpenAPI 只提供 Run、Step 状态事件和 Artifact 资源，尚未提供稳定的 Run/Step 日志查询或增量订阅契约。前端不得读取 Dagu 原始日志接口、拼接 Provider URL，也不得把 Step 输出字段临时当作完整日志。

实现前置：

- [ ] 在 `internal/ports` 定义 Provider-neutral 日志接口，支持 `run_id`、可选 `step_id`、cursor/时间范围、分页和最大字节数；返回时间、级别、来源、文本、trace/request ID。
- [ ] 在 Dagu adapter 实现该接口，固定版本和字段映射；服务端校验路径、租户和 Run 权限。
- [ ] 更新 `api/openapi.yaml` 和生成代码，确定稳定日志资源及可选 SSE 增量事件，明确 cursor 失效、截断、终态和权限错误语义。
- [ ] Control Plane 限制单次响应大小、行数和查询时间范围，禁止返回凭据、环境变量和 Provider 内部 URL。
- [ ] 前端提供 Run/Step 筛选、级别和时间排序、加载更多、截断提示和受控复制；断线后用 cursor/Run 快照恢复并去重。
- [ ] 日志不可用时显示明确错误或空态，不回退到 fixture、本地缓存或 Dagu UI 链接。

测试与验收：

- [ ] ports/adapter 契约测试覆盖分页、cursor、时间范围、大小限制、路径净化和错误映射。
- [ ] HTTP 契约测试覆盖无权 Run、未知 Step、截断响应、过期 cursor 和跨租户访问拒绝。
- [ ] 前端测试覆盖筛选、追加去重、断线恢复、加载失败和超大日志提示。
- [ ] 真实 E2E 验证 Agent → Playbook → Dagu Run 的日志可追踪，并可关联 trace/request ID。

### 9.2 Artifact 展示（待后续具体实现）

状态：**部分完成。** 当前已接入 Artifact 列表和带 Plugin Resource 前缀的下载入口，Run 切换会清理旧列表且加载错误不再静默忽略；历史 Run 选择、文本预览、截断提示、媒体类型处理、权限错误和更完整的刷新恢复仍未完成。Artifact `path` 只能作为服务端不透明引用，不能进入领域模型或被前端拼接成 Provider 地址。

后续实现项：

- [ ] 使用已有 `previewArtifact` 实现文本预览，展示媒体类型、大小、更新时间和 `truncated` 状态；超限时明确提示并提供下载原文。
- [ ] 对 PNG/JPEG/SVG、Audio、Embedded Resource 等类型采用受控预览或下载；未知媒体不得直接当 HTML 渲染，不信任 SVG 不执行脚本。
- [ ] 列表、预览和下载补齐 loading、空态、403/404、过期 Run 和网络中断状态；下载 URL 已改为完整 Control Plane Plugin Resource URL，服务端权限校验仍必须保持。
- [ ] 刷新页面后根据 Run 重新拉取 Artifact，处理列表变化、重复事件、删除/过期引用和下载重试。
- [ ] 如需进入 Agent 消息或 Canvas，先定义 provider-neutral 视觉产物契约，不复用 Workbench 本地 Canvas 状态作为持久化事实。

测试与验收：

- [ ] gateway 契约测试已覆盖列表、预览、下载 URL 前缀与编码；媒体类型分支、截断字段和错误状态测试仍待补。
- [ ] 前端测试覆盖文本预览、截断、非文本下载、无权访问、空列表和刷新恢复。
- [ ] 安全测试确认路径穿越、外部 URL、脚本化 SVG 和超大响应均被拒绝或限制。
- [ ] 真实 E2E 验证 `mcp.call` 产生的报告 Artifact 可在插件内定位、预览或下载，且不暴露 Dagu 文件系统路径。

## 11. 阶段 8：Knowledge 产品契约与 RAGLite 垂直切片

状态：**重新收敛中。已有 RAGLite sidecar、Go adapter、REST、MCP 和真实页面可复用，但当前双 Provider 公共接口、
手工索引、threshold、Chunk/score 和前端状态机将由 ADR 0011 取代。真实文件、恢复、迁移和质量门禁尚未通过。**

目标：以 Knowledge Base、Document、自动索引四态、失败重试、Passage 和有序引用 Search 为唯一产品契约；目标部署
只装配 RAGLite。当前不启动未显式启用的 Knowledge，也不把未验收的能力注册给 OpenCode、Codex 或 Dagu。

详细任务、状态机、公共 API、RAGFlow 退出窗口和验收指标见
[Knowledge 产品契约收敛与 RAGLite 单 Provider 执行计划](knowledge-product-contract-execution-plan.md)。旧的
[双 Provider 迁移计划](raglite-knowledge-provider-migration-plan.md) 只保留历史背景。

### 8.0 Runbook、文档与 Playbook 的语义边界

- Runbook 和普通文档都是供人阅读、检索和引用的知识内容，归入 Knowledge 领域；不得因为名称中包含“操作步骤”就迁入可执行 Playbook。
- Playbook 是唯一需要调度和执行的模型，以原生 Dagu YAML 为事实来源。
- 当前阶段暂不实现独立 Runbook 模型、API、CRUD 或专用存储；前端 Runbook 区域只保留明确空态，不使用 fixture 冒充真实数据。
- 后续需要 Runbook 时，优先将其作为 Knowledge 中的一类人类可读文档或标签/分类实现，不创建第二套 Workflow DSL，也不要求它具备执行语义。

### 8.1 新产品契约

- [x] 接受 ADR 0011，决定目标态只支持 RAGLite。
- [ ] 将公共类型从 Collection/Chunk/Retrieval 收敛为 KnowledgeBase/Document/Passage/Search/Citation。
- [ ] Document 状态只保留 queued/indexing/ready/failed；上传自动 queued，失败允许幂等重试。
- [ ] 删除 threshold、score、start/stop、Provider job ID、Provider Chunk ID、精确页码承诺和公共 scope migration。
- [ ] 增加 service、tags_any、tags_all 和多 Knowledge Base 检索。
- [ ] metadata 更新自动重建索引，并通过内部 generation 防止旧任务覆盖新 metadata。

### 8.1.1 公共标识与最小授权前置

- [x] 通过 ADR 0004 冻结 KnowledgeBase/Document 确定性公共 ID、Provider 原生 metadata 和无影子数据库方案。
- [x] Plugin Backend 丢弃浏览器伪造的身份与 Folder 头，并通过 Grafana RBAC 校验 `folders:uid:<uid>` 后注入可信上下文。
- [x] Control Plane 对所有 Knowledge 管理和检索操作重新校验 Actor/Folder 范围；公共 ID 不作为授权凭据。
- [x] Knowledge MCP Token 在服务端绑定固定 Actor 与 Folder allowlist，缺失或越界默认拒绝。
- [x] 覆盖跨 Folder 列表、详情、修改、删除、检索和 MCP 调用的拒绝测试。

### 8.2 RAGLite Provider 与部署

- [ ] provider.sqlite 持久化自动索引队列、状态转换、generation、attempts 和重启恢复。
- [ ] 上传、任务创建、索引和删除的半成品均可补偿或对账。
- [ ] Search 只读取 ready Document，强制 Folder/Knowledge Base/service/tag 过滤。
- [ ] Passage 不返回 DuckDB Chunk ID，location 只作可选显示信息。
- [ ] 固定 RAGLite、Embedding、DuckDB 扩展、Pandoc 和镜像 digest，并完成离线预热。
- [ ] 演练 provider.sqlite、raglite.db、originals、模型 revision 和 ID key 的备份恢复。

### 8.3 Knowledge MCP

- [x] 在 Control Plane 中暴露 Streamable HTTP MCP endpoint。
- [x] 实现 `knowledge.search`。
- [x] 实现 `knowledge.get_document`。
- [x] 实现 `knowledge.list_sources`。
- [x] MCP 工具只接受业务 ID，不接受 Provider Dataset ID。
- [ ] Search 删除 threshold/score，增加多 Knowledge Base、service 和 tags 过滤。
- [ ] `get_document` 改用产品化 Passage，并继续限制单 Passage、数量和总响应大小。
- [ ] 重新通过真实 MCP 客户端覆盖鉴权、越权、ready-only 和响应边界后再注册运行时。

### 8.4 前端接入

- [x] 已有真实 `KnowledgeGateway` 和管理 Gateway 可作为迁移基线。
- [ ] 上传后显示 queued，不再显示 pending、手工索引或停止按钮。
- [ ] failed 提供重试，Passage 分页浏览，Search 不显示相关性百分比。
- [ ] real 模式只保留 Knowledge Base、Document、Passage 和 Search；Runbook 作为文档/标签，不接回 fixture 模型。
- [ ] 增加真实能力状态、错误对账、Folder 切换取消和真实浏览器 E2E。

已提交独立评测命令 `go run ./cmd/knowledge-eval`，会拒绝少于 30 条的样例集，并强制检查解析成功率、Top 5 命中率、越权结果和删除残留。下列验收指标只有在真实租户凭据和私有评测集到位并产出报告后才视为通过。

验收数据集：30～50 份真实运维文档，覆盖中文、错误码、PromQL、日志、Markdown 代码块、PDF 表格和 DOCX 标题。

验收指标：

- 解析成功率不低于 95%。
- 人工标注片段进入 Top 5 的比例不低于 85%。
- 无权范围的检索请求 100% 被拒绝。
- 删除文档后在约定时间内不再返回其 Passage 或引用。
- Knowledge Provider 不可用时，前端收到 Aegis 受控错误而不是内部响应体。
- 不启动 Knowledge Provider 时，Grafana、Dagu 和 Agent 已完成的链路仍可独立开发和运行。

## 12. 阶段 9：端到端业务闭环

首个黄金场景：**告警诊断并执行受控 Playbook**。

固定测试步骤：

1. 在 Grafana 中准备可触发的测试告警和指标/日志数据。
2. 在 RAGLite Knowledge Provider 中导入服务说明、历史故障和操作约束。
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
- [ ] Knowledge Provider 检索超时。
- [ ] Dagu Run 失败和重试。
- [ ] Agent Provider 中途重启。
- [ ] SSE 连接断开并恢复。
- [ ] 用户拒绝审批。
- [ ] 重复提交同一操作。

## 13. 阶段 10：身份、安全与生产化

前期已经传递最小 Actor Context；本阶段完成生产身份校验、细粒度授权和运行安全，
不能再继续使用开发环境固定身份或仅依赖网络边界。

任务：

- [ ] Plugin Backend 补全并验证 Grafana Org、用户、角色和 Folder 授权上下文（Knowledge 所需最小链路已前置到阶段 8，阶段 10 完成全产品生产化）。
- [ ] Control Plane 校验受信来源、Actor Context 完整性和调用链签名或等价凭证。
- [ ] Folder 级 Knowledge 授权生产化（阶段 8 先完成真实链路和默认拒绝，阶段 10 补密钥轮换、多用户委托与运维策略）。
- [ ] Dagu 和 Grafana 写操作角色映射。
- [ ] Agent 文件系统、网络和命令权限 Profile。
- [ ] Secret Manager、Token 轮换和吊销。
- [ ] 完整审计、敏感字段脱敏和保留策略。
- [ ] TLS/mTLS、NetworkPolicy 和出站 allowlist。
- [ ] RAGLite、Dagu 及 Agent Provider 数据备份恢复演练。
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
- Knowledge Provider 上传、解析、检索和删除评测通过。
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

当前完成 Dagu 与 Grafana MCP 基本链路后，按以下顺序继续，避免并行铺开后没有可运行链路：

1. 保持当前基本 Playbook 执行能力及 OpenCode + DeepSeek 会话闭环稳定，持续运行本地真实冒烟与契约验证（本轮完成）。
2. 后续阶段补齐 Grafana 插件内的 Run/Step 日志和 Artifact 预览/媒体展示；Human Task、Approval、Artifact 列表/下载已完成，继续消除对 Dagu UI 的产品依赖。
3. 按 ADR 0011 收敛 Knowledge 产品契约和 RAGLite 四态自动索引，完成 RAGFlow 数据迁移、只读/回退窗口与最终退出。
4. 使用真实 RAGLite 与至少 30 份运维文档执行 Passage、Search、权限、恢复和质量门禁；通过后再向 OpenCode、Dagu
   和 Codex 注册新 Knowledge MCP，并继续完成多用户隔离设计。
5. 会话稳定后补齐 Canvas 与视觉 Artifact，再收口 Workbench、Approvals、Alerts 和 Audit 的真实 Gateway。
6. 完成包含知识检索的黄金 E2E 场景，再进入 Runbook 产品设计、告警沉淀、Playbook 生成和代码分析等功能。
