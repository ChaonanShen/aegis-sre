# Skill、Alerts 与 Audit 权限接入设计

- 状态：设计已冻结，真实模块接通时实施
- 日期：2026-08-16
- 基线：[统一权限设计](authorization.md)

本文只冻结尚未形成真实产品闭环的 Skill、Alerts 和 Audit 的权限边界，不提前增加 Provider、数据库或虚假的
real Gateway。模块接入时必须把本文的服务端校验、前端能力和测试放在同一实施阶段完成。

## 1. 共通约束

- 浏览器权限只控制体验；Plugin Backend 和 Control Plane/Grafana API 必须再次授权。
- Grafana Folder UID 只作为请求目标。Folder-owned 资源仍需从唯一事实来源恢复 owner 并做一致性检查。
- Provider 类型、Grafana action string、Token 和 SDK 类型不能进入领域模型或前端公共契约。
- 未配置真实 Provider 时返回 `capability_unavailable`，不得回退 fixture、LocalStorage 或内存数据。
- 每个新路由必须先登记 RoutePolicy；未知 `/api/v1/` 路由保持 fail-closed。

## 2. Skill

### 2.1 生命周期与归属

首版采用“User-owned 私人草稿 -> 显式发布为 Folder-owned 版本”：

| 资源/操作 | owner | 服务端权限 |
| --- | --- | --- |
| 私人草稿 CRUD、预览 | User | 当前用户是 owner |
| 发布草稿 | 目标 Folder | 草稿 owner + 目标 Folder `admin` |
| 已发布版本读取/调用 | Folder | `read` |
| 已发布版本编辑或生成新版本 | Folder | `write` |
| 撤回、删除、跨 Folder 迁移 | Folder | 源 Folder `admin`；迁移还要求目标 Folder `admin` |
| 系统内置 Skill | Deployment | 普通用户只读；仅随版本发布 |

发布必须创建不可变版本，不能把私人草稿原地改成共享对象。已发布 Skill 的 owner、版本和内容必须由将来选定的
Skill Provider 原生保存；如果 Provider 无法表达这些事实，先提交 ADR，不增加 Aegis ownership 影子表。

读取 Skill 不授予它调用的工具权限。每次执行仍按当前用户、请求 Folder 和工具风险签发逐 Turn 委托；发布者或
Folder Admin 不能把 Skill 声明成更高权限。Skill 中的 Folder、tool 和 access 声明只能衰减，不能扩大委托。

### 2.2 前端和验收

- 草稿页不要求 active Folder；发布、共享列表和执行必须有 active Folder。
- View 可查看/调用已发布版本，Edit 可编辑并生成版本，Admin 可发布、撤回、删除和迁移。
- 跨用户草稿 ID、跨 Folder 版本 ID、撤权后调用、恶意 tool/access 声明和 Provider owner 不一致全部拒绝。
- Provider、版本/发布 metadata 和回滚语义冻结后，必须新增独立 ADR 才能开始真实实现。

## 3. Alerts 与 Dashboard

Alert Rule、Dashboard、Folder、Mute Timing 和 Grafana-managed Contact Point 的事实来源均为 Grafana。Aegis 不使用
`folder-resources:*` 代替 Grafana 原生资源权限，也不保存规则或 Dashboard 副本。

| 操作 | 授权来源 |
| --- | --- |
| Dashboard/Alert Rule 列表和详情 | Grafana 原生 read action + 实际 Folder scope |
| 创建、编辑、暂停和恢复规则 | 对应 Grafana 原生 write action + 实际 Folder scope |
| 删除规则或 Dashboard | 对应 Grafana 原生 delete action + 实际 Folder scope |
| Mute Timing、Contact Point 等组织级资源 | Grafana 对应组织级 action/scope，不伪装成 Folder 权限 |
| Agent 调用 | 用户短期委托 ∩ Grafana MCP 工具策略 ∩ 低权限 Service Account |

真实页面优先通过 Plugin Backend 调 Grafana 官方 API，浏览器不持有 Service Account。请求若涉及 Folder-owned
资源，Plugin Backend 必须从 Grafana 响应恢复实际 Folder 并与请求 scope 比较；组织级资源不得借 active Folder
隐藏其真实授权范围。

验收至少覆盖 View/Edit/Admin、跨 Folder UID、规则移动、权限撤销、Grafana authz/API 不可用、组织级资源和
Agent MCP 权限衰减。负责人、事故状态、备注等 Aegis 产品字段接入前必须先确定 Grafana annotation 或外部
Incident Provider 这一唯一事实来源。

## 4. Audit

Audit 是结构化日志和 trace 的只读投影，不是授权事实来源，也不建立可被业务写接口修改的审计数据库。

### 4.1 事件契约

事件至少包含 Tenant/Org/User、requested/authorized/resource Folder、资源类型和脱敏 ID、业务 action、
required/granted access、decision/result、受控错误码、request/trace ID、发生时间和委托 jti 摘要。禁止记录原始
ID Token、委托 Token、Provider credential、YAML/文档正文、Prompt 或 MCP 敏感结果。

### 4.2 查询权限

| 事件 | 查询条件 |
| --- | --- |
| Folder 资源成功事件 | 当前用户对 `resource_folder_uid` 至少有 `read` |
| User-owned Session/Canvas | 当前用户是 owner |
| 无 authorized Folder 的拒绝事件 | 仅 Org Admin 安全审计视图 |
| 组织配置、安全和 orphan 事件 | Org Admin |

Audit Gateway 只访问既有日志/可观测性 Provider。查询时必须把可信 User/Org/Folder 条件下推，并在返回后再次过滤；
不能把浏览器传入的 Folder 当查询授权。普通 Folder 用户看不到拒绝事件声明的未知资源是否存在。

### 4.3 实施门禁

- 先提交 Audit Provider/保留期/脱敏规则 ADR，再替换 fixture Gateway。
- requested scope 永远不会被投影成 authorized/resource scope。
- 日志不可用返回 `capability_unavailable`，不显示 fixture。
- 覆盖跨 Org、跨 Folder、Session owner、拒绝事件、脱敏和分页游标篡改测试。

## 5. 模块接通检查表

每个模块上线提交必须同时包含：唯一事实来源 ADR、Provider-neutral port、RoutePolicy、服务端 owner 复核、前端
capability、View/Edit/Admin 或 owner 体验、结构化审计、跨 scope 测试、Provider 不可用测试和真实 E2E。任何一项
未完成时，真实 capability 保持关闭。
