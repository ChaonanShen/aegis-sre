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

RAGFlow 依赖较多、资源占用较大，放在 Dagu 与 Grafana MCP 基本链路稳定之后接入，但优先于 Agent 会话和 Canvas 增强。
Knowledge 的公共接口仍先行冻结；完成真实检索与授权验收后保留 MCP 能力，待 Agent 接入时再注册给 Codex/OpenCode。

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
- Dataset、Document、解析状态、Chunk、Embedding 和索引由 RAGFlow 持久化。
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
- [x] KnowledgeBase 与 Document 使用 RAGFlow 原生资源及 metadata 能力；不建立 Dataset/Document 影子表。
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

状态：**基本执行链已完成。插件可直接启动、查看和取消 Dagu Run，并展示 Step 状态；完整运行观测与交互仍需在阶段 7 收口。**

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

本阶段使用只实现允许工具的 MCP contract server 验证 `mcp.call` 协议、限制和 Artifact；
不得迁入实验用 Prometheus MCP。对 Grafana 官方 MCP 的真实调用在阶段 5 补充验收。

### 4.4 前端接入

- [x] Grafana Plugin 经 Plugin Backend、Control Plane 到 Dagu 完成 Playbook CRUD 与真实 E2E。
- [x] 使用原生 Dagu YAML 作为编辑内容和事实来源。
- [x] 迁移 Playbook DAG 可视化，不反向生成第二套 DSL。
- [x] 实现真实 `PlaybookGateway`。
- [ ] 展示 Run、Step、Human Task、Approval 和 Artifact（Run、Step 已接入；Human Task、Approval、Artifact 待补）。
- [x] 删除真实模式下的 Playbook fixture fallback。

本轮明确只保证 Playbook 可以从 Grafana 插件基本执行，不把 Dagu UI 当作最终产品界面。当前插件仍缺少运行参数表单、retry 操作、Step 日志、Human Task、Approval、Artifact 预览/下载和更完整的失败诊断；这些能力后端契约已有部分基础，但前端尚未闭环，必须在阶段 7 补齐，不能把“Dagu UI 可查看”视为完成。

验收标准：

- CRUD、validate、run、cancel、retry 可用。
- Human Task 和 Approval 暂停后可以从插件恢复运行（本轮暂缓，保留为未完成验收项）。
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

状态：**执行中。OpenCode + DeepSeek 的本地核心会话闭环已完成真实冒烟；Knowledge MCP 已按阶段 8 的边界接入 OpenCode 和 Dagu，Grafana Read MCP 保持不变。Codex 进程启动早于 Control Plane HTTP 监听，不能把 Control Plane 自身的 Knowledge endpoint 配成 required MCP 形成启动环；该启动时序重构、审批续流和双 Provider 合同验收仍待完成。**

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

## 10. 阶段 7：核心前端真实模式收口

状态：**部分完成。真实模式 fallback 已收口，Playbook 已接 Dagu，Workbench 已接公共契约；Playbook 完整运行观测、Alerts、Approvals、Audit 与真实 Agent 组合仍待完成。**

目标：先收口不依赖 RAGFlow 的真实功能；Knowledge 页面保持明确不可用，直到阶段 8 的 RAGFlow 垂直切片完成。

任务：

- [x] 生成或实现 Control Plane Resource Client。
- [x] Workbench 使用统一 Agent Event，不再识别旧 AgentType。
- [ ] Workbench 真实会话支持完整的 create/list/read/resume/rename/archive/unarchive/delete、流式 Turn、取消和 Agent Approval；此项优先于 Canvas 增强。
- [ ] 删除迁移遗留的 `saveSession`、前端 `persistenceQueue` 和发送完整 `history` 的真实模式抽象；前端可以乐观渲染，但最终会话与消息必须重新从 Agent Provider 读取。
- [ ] 审计公共 `Session` 的 `folder_uid`、title、status 和时间字段，只保留 Provider 原生可读写或可可靠派生的字段；不支持的持久字段通过显式契约修订移除，不以数据库补齐。
- [x] Playbook 使用 Dagu-backed API。
- [ ] Playbook 在 Grafana 插件内完成参数、retry、日志、Human Task、Approval 和 Artifact 的运行闭环；不得要求用户跳转 Dagu UI 才能判断执行结果。
- [ ] Approvals 汇总 Agent Approval 与 Dagu Approval。
- [ ] Alerts 接入真实 Grafana 告警上下文。
- [ ] Audit 页面接入跨 Provider trace 和操作摘要。
- [x] fixture 仅在显式 fixture/test 模式启用。
- [x] 真实模式中未实现能力显示明确不可用，不静默返回 fixture 数据。
- [ ] 更新 Playwright 用例覆盖 Grafana、Dagu 和 Agent 的真实服务组合。

### 7.1 Canvas 与视觉产物已知缺口（会话闭环后实施）

当前前端已有 Chart/Canvas 模型、布局和 Grafana 查询渲染能力，但新的 Control Plane 真实会话链路尚未完整承载这些状态。本节全部暂缓到核心会话闭环之后，不得误标为已完成：

- [ ] 定义 Provider-neutral 的视觉产物契约，至少区分 Grafana Chart Definition 与 PNG/JPEG/SVG 等普通图片 Artifact。
- [ ] 将 Codex Image/Tool Item、OpenCode File/Message Part 和 Aegis 工具结果统一映射为稳定事件，不让前端识别 Provider 私有类型。
- [ ] 扩展 `artifact.created` 或新增 Canvas 事件，携带受控资源引用、媒体类型、Chart Definition 及 upsert/remove/layout 语义；不得暴露 Provider 文件路径或内部 URL。
- [ ] 修复真实 Workbench adapter 当前忽略 `artifact.created` 的问题，使流式生成的图表或图片可以直接进入消息和 Canvas。
- [ ] 删除 `updateCanvas` 原样返回造成的虚假持久化语义；优先从 Agent Artifact/结构化事件重建 Canvas。若确有无法由 Provider 承载的布局状态，按独立 Canvas ADR 决策，不把它并入 Session/Turn 存储。
- [ ] Grafana 图表优先保存 datasource、PromQL/LogQL、绝对时间范围和 VizConfig，由插件查询真实 Grafana 数据并原生渲染；不得用 Agent 生成的截图替代可交互 Grafana Panel。
- [ ] 为 Agent 提供受控的 Aegis Canvas 发布工具，使 Codex 与 OpenCode 通过同一工具发布图表，而不是分别实现画布协议。
- [ ] 先验证能否从 Provider 会话的结构化事件或 metadata 重建 Canvas；若无法可靠承载产品专有布局状态，先提交 ADR 说明事实来源和最小持久化范围，再决定是否引入存储。
- [ ] 添加刷新恢复、重复事件去重、流式生成期间用户编辑合并、无权 Artifact 拒绝和大图片限制测试。

Canvas 后续验收标准：用户不需要打开 Codex/OpenCode 自带 UI；Agent 生成的 Grafana 图表和普通图片均可在同一个 Grafana Workbench Canvas 中展示，并能在重新打开会话后恢复。

验收标准：

- 真实模式不读取 fixture store。
- Provider ID 和凭据不出现在浏览器响应、URL 或日志中。
- SSE 断线后优先从 Provider 会话快照恢复最终状态；只有 Provider 支持时才重放精确增量，否则明确终止旧流。
- 页面卸载时会取消不再需要的请求和流。

## 11. 阶段 8：RAGFlow 与 Knowledge 最终垂直切片

状态：**实现完成、真实数据验收待执行。RAGFlow、前端、MCP、OpenCode 与 Dagu 已按 ADR 0004 接通；尚需由真实 RAGFlow 租户提供 API Key，并导入至少 30 份真实运维文档运行质量门禁。Codex 注册因 Control Plane/App Server 启动时序存在自依赖，保留在阶段 6 重构，不虚报完成。**

目标：完成 `Grafana Plugin → Control Plane → RAGFlow` 的真实知识链路，并把受限 Knowledge MCP 注册给 OpenCode 与 Dagu。

### 8.0 Runbook、文档与 Playbook 的语义边界

- Runbook 和普通文档都是供人阅读、检索和引用的知识内容，归入 Knowledge 领域；不得因为名称中包含“操作步骤”就迁入可执行 Playbook。
- Playbook 是唯一需要调度和执行的模型，以原生 Dagu YAML 为事实来源。
- 当前阶段暂不实现独立 Runbook 模型、API、CRUD 或专用存储；前端 Runbook 区域只保留明确空态，不使用 fixture 冒充真实数据。
- 后续需要 Runbook 时，优先将其作为 Knowledge 中的一类人类可读文档或标签/分类实现，不创建第二套 Workflow DSL，也不要求它具备执行语义。

### 8.1 基础部署

- [x] 固定 RAGFlow 版本和镜像 digest。
- [x] 为 MySQL、Valkey、对象存储和检索引擎配置持久卷。
- [x] 配置固定版本的外部 Embedding 服务；本地默认小模型仅用于节省资源，生产模型必须单独评测。
- [x] 建立 readiness、备份和恢复说明。
- [x] 记录最低资源、开发机降配方式，以及不启动 RAGFlow 时其他模块的独立开发方式。

### 8.1.1 公共标识与最小授权前置

- [x] 通过 ADR 0004 冻结 KnowledgeBase/Document 确定性公共 ID、RAGFlow 原生 metadata 和无影子数据库方案。
- [x] Plugin Backend 丢弃浏览器伪造的身份与 Folder 头，并通过 Grafana RBAC 校验 `folders:uid:<uid>` 后注入可信上下文。
- [x] Control Plane 对所有 Knowledge 管理和检索操作重新校验 Actor/Folder 范围；公共 ID 不作为授权凭据。
- [x] Knowledge MCP Token 在服务端绑定固定 Actor 与 Folder allowlist，缺失或越界默认拒绝。
- [x] 覆盖跨 Folder 列表、详情、修改、删除、检索和 MCP 调用的拒绝测试。

### 8.2 Knowledge Adapter

- [x] Dataset 创建、更新和删除。
- [x] 文档上传、开始解析、停止解析和删除。
- [x] 文档解析状态轮询与状态映射。
- [x] 文档、Chunk 分页浏览。
- [x] 混合检索、阈值、Top K 和引用位置映射。
- [x] 请求超时、只读请求有限重试、响应限额和错误净化。
- [x] 验证 RAGFlow Dataset/Document 的公共标识与 metadata 查询策略，不建立映射表。
- [x] 对不确定的变更结果禁止自动重试，并提供 `provider_result_unknown` 对账语义。

### 8.3 Knowledge MCP

- [x] 在 Control Plane 中暴露 Streamable HTTP MCP endpoint。
- [x] 实现 `knowledge.search`。
- [x] 实现 `knowledge.get_document`。
- [x] 实现 `knowledge.list_sources`。
- [x] MCP 工具只接受业务 ID，不接受 Provider Dataset ID。
- [x] 检索前根据 Actor、Folder 和 Service 收敛范围。
- [x] 限制结果数量、单 Chunk 长度和总响应大小。
- [x] 通过真实 MCP 客户端覆盖鉴权、越权拒绝和响应边界，并注册到 OpenCode 与 Dagu；Codex 注册等待阶段 6 启动时序重构。

### 8.4 前端接入

- [x] 实现真实 `KnowledgeGateway` 和管理 Gateway。
- [x] Runbook 区域保持明确空态；当前不实现 Runbook Gateway、fixture fallback 或向 Playbook 的迁移逻辑。
- [x] 替换真实模式下的 Knowledge fixture fallback。
- [x] 展示解析状态、失败原因、引用和原文位置。

已提交独立评测命令 `go run ./cmd/knowledge-eval`，会拒绝少于 30 条的样例集，并强制检查解析成功率、Top 5 命中率、越权结果和删除残留。下列验收指标只有在真实租户凭据和私有评测集到位并产出报告后才视为通过。

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

- [ ] Plugin Backend 补全并验证 Grafana Org、用户、角色和 Folder 授权上下文（Knowledge 所需最小链路已前置到阶段 8，阶段 10 完成全产品生产化）。
- [ ] Control Plane 校验受信来源、Actor Context 完整性和调用链签名或等价凭证。
- [ ] Folder 级 Knowledge 授权生产化（阶段 8 先完成真实链路和默认拒绝，阶段 10 补密钥轮换、多用户委托与运维策略）。
- [ ] Dagu 和 Grafana 写操作角色映射。
- [ ] Agent 文件系统、网络和命令权限 Profile。
- [ ] Secret Manager、Token 轮换和吊销。
- [ ] 完整审计、敏感字段脱敏和保留策略。
- [ ] TLS/mTLS、NetworkPolicy 和出站 allowlist。
- [ ] RAGFlow、Dagu 及 Agent Provider 数据备份恢复演练。
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

当前完成 Dagu 与 Grafana MCP 基本链路后，按以下顺序继续，避免并行铺开后没有可运行链路：

1. 保持当前基本 Playbook 执行能力及 OpenCode + DeepSeek 会话闭环稳定，持续运行本地真实冒烟与契约验证（本轮完成）。
2. 补齐 Grafana 插件内的 Playbook 参数、retry、日志、Human Task、Approval 和 Artifact，消除对 Dagu UI 的产品依赖。
3. 使用真实 RAGFlow 租户与至少 30 份运维文档执行 Knowledge 质量门禁；代码链路、OpenCode/Dagu MCP 和前端已完成，Runbook 页面保持空态。
4. 重构 Codex App Server 与 Control Plane HTTP 的启动时序后注册 Knowledge MCP，再统一其他已验收 MCP，补齐审批、重启恢复与双 Provider 合同测试，随后完成多用户隔离设计。
5. 会话稳定后补齐 Canvas 与视觉 Artifact，再收口 Workbench、Approvals、Alerts 和 Audit 的真实 Gateway。
6. 完成包含知识检索的黄金 E2E 场景，再进入 Runbook 产品设计、告警沉淀、Playbook 生成和代码分析等功能。
