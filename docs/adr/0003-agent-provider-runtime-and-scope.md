# ADR 0003：Agent Provider 运行时、隔离范围与能力差异

- 状态：接受
- 日期：2026-08-14

## 背景

阶段 6 需要把 Codex App Server 和 OpenCode Server 接入同一套 Aegis Session、Turn 与 Event
契约。两个 Provider 均拥有自己的会话持久化，但进程模型和会话能力并不完全相同：Codex 使用
长期运行的双向 JSON-RPC App Server，OpenCode 使用 HTTP 与 SSE；Codex 原生支持
unarchive，OpenCode 1.18.18 的固定版公开 HTTP 契约尚不能证明可以清除 archive 状态。

公共 Session ID 的无状态转换只能解决直接引用，不能阻止共享 Provider 的 list 接口返回其他
Actor 的会话。若在隔离能力未验证前允许多个 Actor 共用一个 Provider 数据目录，会造成权限边界
绕过；若通过 Aegis Session 表过滤，又会重新引入第二事实来源。

Knowledge MCP 尚未完成真实授权验收，但 Grafana Read MCP 与 Dagu 主链路已经可独立验证。
要求 Agent 等待 Knowledge 会造成不必要的顺序阻塞。

## 决策

1. 阶段 6 的核心 Agent 会话先于阶段 8 Knowledge 实施。首轮 Agent 只注册已经真实验收的
   Grafana Read 与 Dagu MCP；Knowledge MCP 未接入时保持明确不可用。
2. 首个版本仍使用部署级 `AGENT_PROVIDER=codex|opencode`，同一 Control Plane 只装配一个
   Provider，不支持逐 Session 选择。
3. 启用 Agent 时必须配置唯一受信 Actor 范围，至少固定 Tenant、Org 和 User。Control Plane
   对不匹配的 Actor fail-closed。该限制使首版运行时成为单 Actor 会话空间，而不是伪装成已经
   支持多用户隔离。
4. 后续若支持多用户 private Session，优先使用按 Actor 确定性隔离的 Provider 进程和数据目录，
   或 Provider 原生租户空间；在另行 ADR 前不得让多个 Actor 共享可列举全部会话的数据目录，
   也不得增加 Aegis Session 影子表。
5. `FolderUID` 只作为请求时的授权上下文，不属于 Provider Session 的持久属性。公共响应中的
   兼容性可选字段保持为空，领域模型和 Provider Port 不保存它。
6. 两个 Provider 共享相同 HTTP 路径、公共类型和事件 Schema。Provider 原生能力确有差异时，
   使用稳定的 `capability_unavailable`，不得用 delete、内存标记或自建存储模拟 archive、
   unarchive 或精确事件重放。
7. OpenCode Adapter 可以同时调用固定版 V2 `/api/*` 与兼容 V1 endpoint，但每个操作的版本
   选择必须记录在 adapter 内，并由 OpenCode 1.18.18 OpenAPI 合同和真实 Server 测试验证；
   不引入 Node SDK 中间服务。
8. 浏览器断线只终止当前订阅，不等同于取消 Provider Turn。用户显式停止必须调用公共 Turn
   cancel API；Provider 终态仍从原生事件或会话快照确认。

## 结果

- 阶段 6 可以在 Knowledge 尚未接入时形成真实 Agent 闭环。
- 首版生产配置不会把共享 Provider 会话错误地暴露为 private Session。
- Provider 能力差异显式可见，但 Provider 类型和内部 ID 仍不进入公共契约。
- Control Plane 继续保持无状态，不拥有 Session、Turn、Message、Approval 或事件历史。
- 多用户 Agent 能力在新的隔离 ADR 和验收完成前保持关闭。
