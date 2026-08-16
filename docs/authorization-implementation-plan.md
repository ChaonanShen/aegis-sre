# Aegis SRE 统一权限实施计划

- 状态：执行中（核心 REST/前端权限闭环已完成，生产委托与真实环境验收待完成）
- 日期：2026-08-16
- 设计基线：[权限与资源归属设计](authorization.md)
- 基线提交：`f26ee4d`
- 适用模块：Grafana Plugin、Plugin Backend、Control Plane、Knowledge、Playbook、Agent、Canvas、MCP

## 1. 结论与实施原则

Knowledge、Playbook 和 Agent 会话链路已经接入首版权限，但不能把同一套 Folder 规则机械地套到
所有接口：

- Agent Session、Message 和 Canvas 是 User-owned。列出、打开、改名、归档和删除 Session 只校验当前用户是
  owner；只有发起 Turn、调用 Folder 资源和处理高风险审批时才检查 Folder。
- Knowledge Base 和 Document 是 Folder-owned。现已迁移到通用 read/write/admin 授权链，并完成真实前端闭环。
- Playbook、Run、Step、Approval 和 Artifact 是 Folder-owned。现已使用 Dagu 原生 label 保存 Folder ownership，
  并为旧 Org-scoped `pbk_` 资源提供显式 Folder 下的只读兼容窗口。
- MCP 固定 Token 只代表工作负载。单 Actor 模式可以继续作为过渡部署，多用户模式不得在逐 Turn 委托能力
  落地前开放 Folder-scoped 工具，尤其不能开放 `playbook.start` 等写操作。

实施采用“通用授权基础设施 -> Knowledge 垂直切片 -> Playbook ownership -> Agent Turn -> MCP 委托与审批 ->
生产审计”的顺序。前端权限仅用于交互体验，所有真实读写仍由 Plugin Backend 和 Control Plane fail-closed。

## 2. 当前实现盘点

| 区域 | 当前行为 | 主要缺口 |
| --- | --- | --- |
| Plugin manifest | 已注册 `folder-resources:read/write/admin` actionSets | 修改 manifest 后仍需在真实 Grafana 重启验收 |
| Plugin Backend | RoutePolicy 覆盖 Knowledge、Playbook、Turn、SSE 和下载；默认拒绝未知 API | 真实 Grafana authz 故障与权限撤销场景待 E2E |
| Control Plane | 使用统一可信 FolderAuthorization，按 read/write/admin 二次校验 | `resource_folder_uid` 审计需随生产审计投影继续完善 |
| Folder 前端 | real 模式组合 `/api/search` 与当前用户 permission map，按精确 Folder scope 映射通用 action；无 action 时不可选择 | 多用户权限变更和深链接待真实浏览器验收 |
| Knowledge | REST、Provider、MCP 和真实页面已形成 Folder 权限闭环 | v1 user-bound 数据只读兼容窗口需迁移运营方案 |
| Playbook | Dagu label ownership、父级复核、权限 UI、旧资源只读兼容均已接入 | 真实 Dagu 的跨 Folder/SSE/Artifact 验收待执行 |
| Agent Session | Session 保持 User-owned；Turn 已发送并校验 Folder context | 仍是单 Actor；approve 因无法恢复可信目标而禁用 |
| Knowledge/Playbook MCP | 固定 Actor + Folder allowlist；Playbook 写工具默认关闭 | 缺少逐 Turn 用户委托能力，不能开放多用户写工具 |
| Audit | Plugin Backend 与 Control Plane 已区分 requested/authorized scope | 生产日志投影、脱敏查询和 orphan inventory 待完成 |

已完成的关键修正：

1. Plugin manifest、Plugin Backend RoutePolicy 和 Control Plane 已统一为 Folder read/write/admin。
2. Knowledge v2 scope 已去除 User，使同 Folder 用户能够共享；旧 v1 user-bound 数据仅允许原创建者只读。
3. Playbook Folder ownership 由 Dagu YAML 原生 label 承载，所有子资源操作先恢复 Playbook 并复核 Folder。
4. Workbench Turn、Playbook CRUD/SSE/Artifact 和 Knowledge Gateway 均发送当前 Folder context；Session CRUD 不发送
   Folder，保持 User-owned 语义。
5. 无法持久化可信目标的 Agent approve 返回 `capability_unavailable`；Playbook MCP 写工具默认不注册。
6. 两层授权日志区分 requested/authorized Folder，拒绝请求不会把浏览器声明提升为可信 scope。
7. 本地 Compose 每次启动通过 Grafana 官方 API 幂等确保 `infra`、`payment` 测试 Folder 存在；产品与生产环境仍只在
   Grafana 管理 Folder。
8. Folder Gateway 不再依赖搜索结果中不存在的插件 `accessControl`，而是读取当前用户 permission map，并覆盖
   Folder 精确 scope、通配 scope、无权限过滤和无效响应 fail-closed 测试。

仍未完成且不得绕过的工作：

1. Codex/OpenCode 运行时尚不能安全注入逐 Turn 短期委托；多用户 Agent Folder 工具保持不可用。
2. Agent Provider 尚不能持久化并恢复原生审批目标；approve 保持 fail-closed，reject 仍可终止等待。
3. Grafana Folder 与 Provider 根资源的只读 orphan reconciliation 尚未实现。
4. 三用户、三 Folder 的真实 Grafana + Dagu + Knowledge Provider 生产验收尚未执行。

## 3. 首版权限矩阵

RoutePolicy 和模块实现以以下矩阵为首版默认值。后续如果降低权限要求，必须通过风险评审和回归测试；不能由
某个页面自行降低。

| 资源/操作 | Plugin Backend 要求 | Control Plane 二次校验 |
| --- | --- | --- |
| Capability、Session list/create/read/update/delete | 可信 User | Agent Provider Session owner/scope |
| Canvas read/update、Turn cancel | 可信 User | Session owner；取消不因 Folder 权限撤销而受阻 |
| Start Agent Turn | Folder `read` | Session owner + 可信 Folder context |
| Agent Approval resolve | 首版 Folder `admin` | 从 Provider 恢复真实目标、实时复验；无法恢复则不可用 |
| Knowledge list/get/search/chunks/download | Folder `read` | Provider 返回的 Knowledge Base Folder 必须一致 |
| Knowledge create/update/upload/index/stop、Document delete | Folder `write` | 父 Knowledge Base Folder 必须一致 |
| Knowledge Base delete/迁移 | Folder `admin` | 根资源实际归属一致；迁移还要校验目标 Folder admin |
| Playbook list/get、Run get/list/events、Artifact read/download | Folder `read` | Playbook 的 Dagu 原生 Folder 事实一致 |
| Playbook create/update/validate/start/cancel/retry/Human Task | Folder `write` | Run -> Playbook -> Folder 一致 |
| Playbook delete、Approval resolve、归属迁移 | Folder `admin` | 重新读取 Run/Playbook 并检查状态与归属 |
| 未知 `/api/v1/` 路由 | 拒绝 | 不进入 Provider |

说明：审批首版统一要求 Admin 是安全默认值。哪些低风险审批可降到 write，可以在真实工具风险分级稳定后单独
调整；首版不让浏览器声明风险等级。

## 4. 阶段 0：冻结 ADR 与兼容策略

状态：**已完成。** Playbook Folder ownership 见 [ADR 0009](adr/0009-playbook-folder-ownership.md)，Agent 委托与
Approval target 见 [ADR 0010](adr/0010-agent-delegation-and-approval-target.md)。首版权限风险矩阵已冻结。

### 4.1 Playbook Folder ownership ADR

新增 ADR，扩展或取代 ADR 0001 中只有 Aegis/GitOps 写入归属、没有 Folder ownership 的部分。ADR 必须通过
Dagu 2.13.0 真实契约测试回答：

- Folder scope 使用 Dagu 原生 metadata/tag，还是进入新的 Folder-scoped `pbk_` 命名。
- 如何从 Playbook 恢复 Folder，如何从 Run/Step/Approval/Artifact 追溯到 Playbook Folder。
- 新建 ID 是否由 Tenant/Org/Folder 而不是 User 派生，避免资源随创建者离开而失效。
- 旧 Org-scoped `pbk_` Playbook 如何兼容：建议绑定一个显式配置的 legacy Folder，只读保留一到两个发布周期；
  通过显式复制/导入生成新资源，不在原文件上静默改 owner。
- Dagu 不支持所需原生事实时必须暂停实现，不增加 Aegis ownership 表，也不把 fixture 的 `folder_uid` 写进生产。
- 回滚时旧实现如何只读恢复，以及新旧 Run 如何查询。

完成门禁：ADR 接受、固定版 Dagu 契约测试通过、迁移和回滚样例可复现后，才能修改 Playbook 公共契约和 ID。

### 4.2 Agent 委托与 Approval ADR

多用户 Agent 或 Agent 写工具上线前新增 ADR，冻结：

- 委托能力由 Plugin Backend 直接签发，还是由 Control Plane 使用已验证授权断言换取。
- claims、audience、Turn/Session/Folder/tool 绑定、TTL、唯一 ID、密钥轮换和吊销。
- Codex/OpenCode 如何按 Turn 注入短期能力，Provider 重启和审批长时间等待后如何重新签发。
- Agent Provider 如何在原生 tool-call/approval metadata 中保存不可变目标；不能保存时哪些审批明确不可用。
- 固定 Actor 部署的兼容窗口和多用户功能开关。

完成门禁：ADR 未接受前，多用户 Agent MCP 写工具、Agent Approval approve 和任意固定 Service Account 代用户
写入的路径保持禁用。

### 4.3 首版风险决策

在 `docs/authorization.md` 的未决项中冻结以下首版选择：

- 删除共享 Knowledge Base 和 Playbook 要求 Admin。
- Playbook/Agent Approval 首版要求 Admin。
- Document 删除、Run cancel/retry、Human Task complete 要求 write。
- Session 历史继续采用“授权时点快照”，不把 Session 改成 Folder-bound。

## 5. 阶段 1：通用 Grafana Folder RBAC 基础设施

### 5.1 Plugin manifest

修改范围：

- `grafana-plugin/src/plugin.json`
- `grafana-plugin/pkg/plugin/plugin_manifest_test.go`

任务：

- 注册 `folder-resources:read/write/admin`，分别加入 `folders:view/edit/admin` actionSets。
- Edit/Admin actionSet 显式包含 read，Admin 显式包含 write。
- 旧 `knowledge:read/write` 在一个兼容窗口内同时保留，所有新代码只读取通用 action。
- 不手工修改 `grafana-plugin/.config/`；实施该阶段前重新阅读该目录的插件工作规范。
- 固定 Grafana 和 authlib 版本，运行 manifest 契约测试并重启 Grafana 验证 actionSets 生效。

### 5.2 Plugin Backend RoutePolicy

建议修改/新增：

- `grafana-plugin/pkg/plugin/proxy_app.go`
- `grafana-plugin/pkg/plugin/route_policy.go`
- `grafana-plugin/pkg/plugin/route_policy_test.go`
- `grafana-plugin/pkg/plugin/proxy_app_test.go`

任务：

- 用集中 RoutePolicy 替换 `knowledgeFolderAction`，策略包含 `IdentityRequired`、`FolderRequired`、
  `Access=read|write|admin` 和稳定业务 action 名称。
- 精确覆盖 REST、SSE、Artifact 下载、冒号 action 和动态路径；不能只用 HTTP Method 推导。
- 未登记的 `/api/v1/` 路由 fail-closed，不能直接转发给 Control Plane。
- 将 authz search prefix 从 Knowledge 扩展到整个 Aegis 插件 action；缓存 key 必须包含用户、action 和 Folder。
- `trustedFolder` 支持 admin；向下游只注入服务端验证后的 Folder UID/access。
- 删除浏览器传入的 Actor、Role、Folder access 和审计 verified scope Header，只保留请求 Folder 供授权器读取。
- Grafana authz 不可用返回 503；权限不足返回 403；不得把 Service Account 自身权限当用户权限。
- 记录 10 秒缓存作为权限撤销最大延迟，并为缓存到期后的撤销增加测试。

### 5.3 Control Plane 统一请求授权上下文

建议修改/新增：

- `internal/platform/httpserver/api.go`
- `internal/platform/httpserver/authorization.go`
- `internal/platform/httpserver/authorization_test.go`
- `internal/domain/common.go`（仅在 Provider-neutral 类型确有必要时）

任务：

- 在可信 Plugin Token 校验后一次性解析 Actor 和可选 FolderAuthorization。
- 提供统一的 `requireFolderAccess(read|write|admin)`，handler 不再直接读取
  `X-Aegis-Folder-Access`。
- body/query 中的 Folder 只能与可信 Folder 一致，不能提高 access。
- 生产配置禁止空 Plugin Token；开发模式若需要例外必须是显式开关并有醒目 health 状态。
- Provider port 只接收完成授权后的 Actor 和必要 scope，不引入 Grafana action string 或 authlib 类型。
- 保留 `ActorContext.FolderUID` 作为当前稳定 port 的过渡字段；授权等级放在请求上下文，不扩散到每个 Provider
  输入。后续移除 FolderUID 必须单独做兼容性审计。

完成门禁：Knowledge 旧行为的契约测试全部通过，同时 Playbook/Turn 路由已经能被策略分类但尚未放开 Provider
写入；未知路由和伪造 Header 100% 拒绝。

## 6. 阶段 2：真实前端 Folder 与权限能力

建议修改：

- `grafana-plugin/src/app/adapters/grafanaFolderGateway.ts`
- `grafana-plugin/src/app/AppShell.tsx`
- `grafana-plugin/src/app/AppShellContext.tsx`
- `grafana-plugin/src/app/model.ts`
- 对应 Jest 测试

任务（已完成）：

- 并行读取 `/api/search` 的可见 Folder 与 `/api/access-control/user/permissions` 的当前用户 permission map。
- 按 Admin -> Edit -> View 顺序解析通用 action，只接受 `folders:uid:<uid>` 或 `folders:*`；缺少匹配 read action 的
  Folder 不可选择，权限响应无效时 fail-closed。
- real 模式显示 Folder Dropdown；Folder 列表加载失败、为空和权限被撤销时显示明确状态。
- 将当前带 `fixture` 的 sessionStorage key 迁移为真实产品 scope key，旧 key 只读兼容一个版本。
- Folder 切换立即取消旧请求、清空上一 Folder 的 Knowledge/Playbook/Turn 操作状态，再加载新 scope。
- 页面按钮按 Folder capability 控制：View 只读、Edit 可普通写、Admin 可删除根资源和审批。
- 深链接使用请求时 Folder context，例如受控 query 参数或已验证的当前选择；资源 ID 不能自动决定权限。
- 前端收到 403 后刷新 Folder 列表和页面状态，不继续依赖缓存的 Edit/Admin 判断。

完成门禁：real 模式可在同一用户的 View/Edit/Admin Folder 间切换，无 action 的 Folder 不显示为 View，晚到响应
不会覆盖当前 Folder。当前单元测试已覆盖精确 scope、`folders:*`、无权限过滤、无效 Folder/permission 响应、
请求取消和无 Folder 引导；真实三用户权限矩阵仍属于生产验收项。

## 7. 阶段 3：Knowledge 权限与真实前端垂直切片

Knowledge 可以最先实施，因为 Provider 已保存 Folder UID，公共 ID 也已绑定 Actor/Folder。

### 7.1 后端授权迁移

修改范围：

- `internal/platform/httpserver/knowledge.go`
- `internal/platform/httpserver/knowledge_test.go`
- `internal/adapters/ragflow/`、`internal/adapters/raglite/` 的 Folder scope 合同测试
- `grafana-plugin/pkg/plugin` RoutePolicy 测试

任务：

- 删除 Knowledge 专用 `requireKnowledgeActor` 的 Header 解析，改用统一 FolderAuthorization。
- 按首版矩阵拆分 read/write/admin；Knowledge Base delete 从 write 提升为 admin。
- get/update/delete Document 前先恢复父 Knowledge Base，并验证其真实 Folder；不能只信 Document ID。
- list/search 对 Provider 返回的每个 Collection/Document 做 scope 一致性检查；异常结果 fail-closed。
- Folder 已删除或无法验证时不调用 Provider；Provider 数据留作 orphan，不可通过公共 ID访问。
- 保持 RAGFlow/RAGLite 是唯一事实来源，不增加 Collection/Document 权限表。

### 7.2 前端接入与契约修正

修改范围：

- `grafana-plugin/src/features/knowledge/RealKnowledgePage.tsx`
- `grafana-plugin/src/features/knowledge/adapters/resourceKnowledgeManagementGateway.ts`
- `grafana-plugin/src/features/knowledge/ports/KnowledgeManagementGateway.ts`
- `api/openapi.yaml` 和生成类型

任务：

- 修正真实搜索路径为 `/api/v1/knowledge:search`。
- 统一 Document update 的 PUT/PATCH 契约；保留兼容方法时写明移除窗口。
- 覆盖 Knowledge Base 列表/创建/更新/删除，Document 上传/列表/详情/标签更新/删除、索引开始/停止、Chunk、
  下载和检索。
- View 用户可浏览和搜索；Edit 可上传、编辑、索引和删除 Document；只有 Admin 显示并可执行 Knowledge Base
  删除。
- Folder 切换清空选中的 Knowledge Base、Document、检索结果、上传进度和轮询任务。
- 人类 Runbook 继续作为 Document/标签表达，不把旧 fixture 的 Service/Runbook/Import 状态机迁入真实模式。
- Provider 未配置或不可用时显示稳定 capability/problem，不回退 legacy fixture 页面。

完成门禁：三个真实 Grafana 用户分别以 View/Edit/Admin 完成权限矩阵；强制构造跨 Folder URL、公共 ID、上传、
下载和搜索均无法越权；真实模式无 fixture 内容。

## 8. 阶段 4：Playbook Folder ownership 与权限垂直切片

本阶段必须在 4.1 ADR 完成后实施。

### 8.1 Provider-neutral 契约

建议修改：

- `internal/ports/playbook.go`
- `api/openapi.yaml`
- `grafana-plugin/src/api/generated/controlPlane.ts`
- `internal/domain/playbook_scope.go`

任务：

- 为 Playbook resource/summary 增加 Provider-neutral `folder_uid`；Run 通过 Playbook 继承，不复制独立 owner。
- Create 输入使用可信请求 Folder，不能让 YAML 或浏览器声明 owner。
- 根据 ADR 更新公共 ID/scope 校验；User 不参与共享 Playbook owner 派生。
- 保持原生 Dagu YAML 为唯一内容事实，不增加授权 DSL 或 ownership repository。

### 8.2 Dagu adapter 与 Control Plane

建议修改：

- `internal/adapters/dagu/provider.go`、`client.go`、`types.go` 及合同测试
- `internal/platform/httpserver/playbooks.go` 及测试
- `internal/platform/playbookmcp/handler.go` 及测试

任务：

- list/get/create/update/delete 从 ADR 确定的 Dagu 原生事实读取和校验 Folder。
- 删除 `hasPlaybookWriteRole`，Grafana Org Role 不再授权 Folder 资源。
- Run URL 先解析 `Run -> Playbook`，再校验 Playbook Folder；SSE、Human Task、Approval、Artifact preview/download
  使用同一逻辑。
- Playbook delete 和 Approval resolve 要求 admin；普通执行控制要求 write；读路径要求 read。
- Provider 返回无法证明归属的 DAG/Run 时不投影到前端，返回受控错误或从列表过滤。
- 旧 Org-scoped Playbook 按 ADR 只读兼容，不静默改名，不删除旧 Run。

### 8.3 Playbook 前端

建议修改：

- `grafana-plugin/src/features/playbooks/ports/PlaybookCrudGateway.ts`
- `grafana-plugin/src/features/playbooks/adapters/resourcePlaybookCrudGateway.ts`
- `grafana-plugin/src/features/playbooks/application/usePlaybooksController.ts`
- `grafana-plugin/src/features/playbooks/PlaybooksPage.tsx`
- Run/Human Task/Approval/Artifact 组件及测试

任务：

- 所有 Gateway 方法显式接收 Folder UID 并发送请求 Header；下载 URL 也必须绑定当前 Folder 请求上下文，不能用
  普通 `<a>` 绕过 Header，必要时改成受控 Blob 下载。
- 页面只列出 active Folder 的 Playbook；切换 Folder 时取消列表、详情、Run SSE 和 Artifact 请求。
- View 隐藏编辑、执行和运行控制；Edit 可创建/更新/启动/取消/重试/Human Task；Admin 可删除和审批。
- Playbook 深链接恢复 Folder context 后再读取资源；Folder 与资源实际 owner 不一致时显示 not found。
- 旧只读 Playbook 显示迁移提示，不显示不可执行的写按钮。

完成门禁：Playbook CRUD、Run、SSE、Approval 和 Artifact 均通过跨 Folder 测试；用户失去 Folder 权限后，新请求
在缓存 TTL 内失效；历史 Dagu 数据仍可按兼容策略回退读取。

## 9. 阶段 5：Agent Session、Turn 与 Canvas 权限

### 9.1 Session owner

修改范围：

- `internal/adapters/agentscope/`
- Codex/OpenCode Provider 合同测试
- `internal/platform/httpserver/agents.go`

任务：

- Session list/create/read/rename/archive/delete 保持 User-owned，不要求 active Folder。
- 当前首版继续由 `agentscope.Provider` 限制唯一 Tenant/Org/User；其他 Grafana 用户明确收到 403，不伪装成
  已支持多用户。
- 多用户启用前，按 ADR 0003 使用 Provider 原生租户空间或按 Actor 隔离进程/数据目录；不增加 Session 表。
- Canvas 每次通过 Agent Provider 验证 Session owner，保持现有 User-owned 模型；Folder Admin 不能读取他人
  Canvas。

### 9.2 Turn Folder context

修改范围：

- `grafana-plugin/src/features/workbench/ports/WorkbenchGateway.ts`
- `grafana-plugin/src/features/workbench/adapters/resourceWorkbenchGateway.ts`
- `grafana-plugin/src/features/workbench/application/useWorkbenchController.ts`
- `internal/platform/httpserver/agents.go`
- Plugin Backend RoutePolicy

任务：

- 只有 `streamMessage/StartTurn` 发送 active Folder Header；Session CRUD、Canvas 和 Turn cancel 不发送 Folder。
- Plugin Backend 对 StartTurn 检查 Folder read，Control Plane 同时验证 Session owner 和可信 Folder。
- Folder 切换不改变 Session owner，也不改写 Session；进行中的 Turn 保留启动时 scope，新的 Turn 使用新 scope。
- Folder 被撤销后仍允许 owner 读取历史消息和取消已有 Turn，但不能重试或启动新的 Folder 操作。
- Workbench 无可用 Folder 时仍可管理 Session 历史，但 Composer 明确禁用并说明缺少 Folder context。
- 阶段 6 的逐 Turn 委托尚未完成时，多用户部署不注册 `playbook.start` 等 Folder-scoped 写工具；当前固定
  Actor 工具集只能在显式 single-actor 配置和服务端 Folder allowlist 内运行。

### 9.3 Agent Approval

任务：

- 浏览器业务正文继续只提交 approval ID、decision、reason。Gateway 可以把当前 Folder UID 作为请求 Header 交给
  Plugin Backend 校验 admin，但不发送前端推导的 permission；Control Plane 必须用 Provider 恢复的真实目标与
  已验证 Folder 匹配。React ref 只可控制提示，不能成为授权事实。
- 在 `internal/ports` 定义最小 Provider-neutral Approval target/read 能力，目标至少包含 Session/Turn、tool/action、
  Folder、required access、risk 和 revision。
- Codex/OpenCode adapter 必须从 Provider 原生记录恢复目标，或读取 Provider 保存的服务端签名上下文。
- Resolve 时重新读取 target、验证 Session owner、检查当前 Folder admin 和 revision，再签发新的执行能力。
- 当前 Codex 内存 pending map 无法提供这些保证；改造完成前真实 approve 返回 `capability_unavailable`。Reject 可以
  在确认不会产生副作用且 Session owner 校验通过后单独保留。

完成门禁：Session 历史不依赖 Folder；StartTurn 必须有 read；Approval 不能相信浏览器 Folder；Provider 重启或
审批目标丢失时 fail-closed。

## 10. 阶段 6：MCP 用户委托与工具权限衰减

本阶段按 4.2 ADR 实施，不与普通 REST Folder Header 混用。

建议范围：

- Plugin Backend/Control Plane 委托签发或交换组件
- Agent Provider Turn runtime 配置
- `internal/platform/knowledgemcp/handler.go`
- `internal/platform/playbookmcp/handler.go`
- Canvas MCP 和 Grafana MCP 鉴权网关
- 配置、Secret、轮换和合同测试

任务：

- 为每个 Turn 签发绑定 User、Session、Turn、Folder、最大 access、tool/action、audience、expiry、jti 的短期能力。
- MCP handler 同时验证工作负载 Token 和用户委托能力，按“委托 ∩ allowlist ∩ 工具策略 ∩ 服务凭据”计算有效权限。
- Folder、tool、audience、Turn 任一不匹配都拒绝；模型参数不能扩大 scope。
- `knowledge.search/get/list` 要求 read；`playbook.start` 要求 write；未来新增写工具逐项登记。
- 高风险审批通过后执行时重新签发能力，不能复用创建 Approval 时的 token。
- 固定 Actor + Folder allowlist 只在显式 single-actor 配置中保留；多用户模式检测到固定身份时启动失败或禁用工具。
- 委托落地前，多用户 Agent 仅允许不注册 Folder-scoped MCP；不能用只读 Service Account 猜测用户权限。

完成门禁：两个不同用户、两个不同 Folder、read/write/admin 组合的真实工具 E2E 通过；Token 过期、轮换、重放、
跨 audience、跨 Turn 和跨 Folder 全部拒绝。

## 11. 阶段 7：Audit、Folder orphan 与生产门禁

### 11.1 结构化审计

任务：

- 在 Plugin Backend 记录 requested Folder、required action、授权结果和 request/trace ID。
- 在 Control Plane 追加 authorized Folder、resource Folder、Provider 操作结果；拒绝事件不伪造 verified scope。
- 日志字段使用 `requested_folder_uid`、`authorized_folder_uid`、`resource_folder_uid`，并记录 required/granted access。
- 无 authorized Folder 的拒绝事件只进入安全审计视图；普通 Folder Audit 页面不能按用户请求值读取它们。
- 不记录 Grafana ID Token、Service Account Token、委托 Token、Provider credential、YAML/文档正文或 MCP 敏感结果。

### 11.2 orphan reconciliation

任务：

- 使用只读后台任务枚举 Provider 中 Aegis-managed Knowledge/Playbook 根资源，与 Grafana Folder 存在性对账。
- 任务只输出 orphan inventory 和指标，不自动删除、迁移或改 owner。
- 增加独立 Org Admin 治理入口前先冻结操作审计、目标 Folder admin 校验、并发版本和回滚语义。
- 普通资源接口始终 fail-closed；治理入口不能复用公共资源详情 API 绕过已消失 Folder。

### 11.3 生产验收

- 使用至少三个 Grafana 用户、三个 Folder，覆盖 View/Edit/Admin 和跨 Folder 组合。
- 覆盖 REST、SSE、Blob 下载、刷新、深链接、权限撤销、Grafana authz 不可用、Provider 返回错误 owner。
- 执行 Token 轮换、Grafana 重启、Control Plane 重启、Agent Provider 重启和 Dagu/RAG Provider 重启。
- 运行 `make verify`、真实 Knowledge 冒烟、Agent + Playbook E2E 和权限拒绝场景。
- 所有真实能力不可用时返回稳定错误，不回退 fixture/mock。

## 12. 推荐提交边界

按以下独立提交执行，便于审查和回滚：

1. `docs: 冻结 playbook ownership 与 agent 委托 ADR`
2. `feat(authz): 注册通用 folder actions 和 route policy`
3. `feat(authz): 统一 control plane folder authorization`
4. `feat(plugin): 开放真实 folder 选择与通用权限映射`
5. `feat(knowledge): 接入统一 folder 权限和真实前端`
6. `feat(playbook): 持久化原生 folder ownership 并迁移权限`
7. `feat(agent): 为 turn 接入 folder context 并收紧 approval`
8. `feat(mcp): 接入逐 turn 用户委托能力`
9. `feat(audit): 增加授权审计和 orphan reconciliation`
10. `test(authz): 增加多用户跨 folder 真实验收`

不要把 actionSets、所有模块迁移和前端 UI 合成一个大提交。每个模块提交必须能在上一阶段基础上独立 fail-closed，
不能存在“后端已经要求 Folder，但前端尚不会发送”导致真实模式整体不可用的发布状态；需要同一发布完成的改动应
通过 feature flag 默认关闭，待前后端同时就绪后启用。

## 13. 测试命令与完成定义

每个阶段至少运行：

```bash
go test ./internal/platform/httpserver ./internal/platform/knowledgemcp ./internal/platform/playbookmcp
(cd grafana-plugin && go test ./pkg/plugin/...)
(cd grafana-plugin && npm run typecheck && npm run lint && npm run test:ci)
make contracts-check
make verify
```

涉及 Dagu、Knowledge Provider、Grafana authz 或 Agent runtime 的阶段还必须运行固定版本真实合同/冒烟，单元 fake
不能代替发布验收。

本地回归使用：

```bash
make local-up
make local-smoke
```

`local-up` 会重建容器并重跑一次性 Grafana bootstrap，确保 `infra`、`payment` 存在；`local-smoke` 默认以
`infra` 作为 Folder context，覆盖 Dagu -> Grafana MCP、Plugin -> Control Plane -> Dagu Playbook 和
Plugin -> Control Plane -> OpenCode 三条真实路径。该流程只验证本地单 Actor 栈，不能替代三用户、三 Folder 的
生产权限矩阵。

整个计划完成的定义：

- Session owner 与 Folder owner 语义没有混用。
- Knowledge、Playbook、Turn、SSE、Approval 和 Artifact 下载均执行相同 Folder 权限矩阵。
- 浏览器、公共 ID、模型参数和固定 Service Account 都不能独立成为授权凭据。
- Provider 类型、Grafana action string 和 authlib 类型未进入前端公共契约或领域模型。
- Dagu YAML、Agent Provider 和 Knowledge Provider 仍是各自唯一事实来源，没有新增授权影子数据库。
- View/Edit/Admin 用户和权限撤销、跨 Folder、服务不可用场景通过真实 E2E。
- 多用户 Agent 写工具只有在逐 Turn 委托与审批目标恢复均完成后才可启用。
