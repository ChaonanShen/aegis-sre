# ADR 0010：Agent MCP 用户委托与 Approval 目标恢复

- 状态：接受
- 日期：2026-08-16
- 适用范围：Agent Turn、Knowledge/Playbook/Canvas/Grafana MCP 和 Agent Provider Approval

## 背景

当前 Agent Provider 由固定 Tenant/Org/User 的单 Actor scope 保护，Knowledge/Playbook/Canvas MCP 使用固定
Actor Token 和 Folder allowlist。固定 Token 只能证明工作负载身份，不能证明发起某次 Turn 的 Grafana 用户
现在拥有目标 Folder 的 write/admin。StartTurn 的一次 read 校验也不能授权稍后的 `playbook.start` 或审批执行。

当前 Codex Approval 只在 Adapter 内存中保存 Provider request、Thread 和 Turn；公共 decision 只有 approval ID、
decision 和 reason。浏览器的 `pendingHITLFolderUidRef` 是瞬时 UI 状态，服务端无法从中恢复可信目标。OpenCode
1.18.18 又没有已接通的原生 approval continuation。为审批增加 Aegis 影子表会违反 Provider 唯一事实来源。

## 决策

### 身份与签发者

1. 长期 MCP/Service Account Token 继续只作为工作负载身份，不能携带最终用户权限。
2. Plugin Backend 使用当前请求的 Grafana ID Token 查询 Folder read/write/admin，向 Control Plane 注入经过内部
   Plugin Token 保护的 Provider-neutral Actor、Folder 和最高已验证 access。
3. Control Plane 是短期用户委托能力的唯一签发者。它在验证 Session owner、StartTurn 输入和 Plugin Backend
   授权断言后签发；浏览器、模型、Agent Provider 和 MCP 服务都不能签发或扩大能力。
4. 签发使用 Ed25519/EdDSA 的版本化 JWT，依赖固定版本的成熟 JOSE/JWT 库，不自研通用 Token 协议。私钥只挂载
   到 Control Plane；MCP 服务和鉴权网关只获得带 `kid` 的公钥集合。

### 委托能力

Token 至少包含并验证：

- 标准 `iss`、`aud`、`sub`、`jti`、`iat`、`nbf`、`exp`；
- Tenant、Org、Grafana User；
- 公共 Session ID 和本次 Turn 的稳定 operation ID/turn nonce；
- Folder UID 和最高 access；
- 允许的 MCP server、tool/action；
- contract version。

首版 TTL 为 5 分钟，不提供静默续期。超过 TTL 的长 Turn 后续工具调用明确失败，用户可以发起新 Turn；审批
恢复执行时重新查询权限并签发新 Token。TTL 加 Plugin Backend authz cache TTL 是权限撤销的最大传播延迟，必须
进入运行文档和测试。

Token 不建立中心化 jti 状态表。首版通过短 TTL、TLS、audience、Session/Turn/Folder/tool 绑定和 Provider 原生
幂等键限制重放；安全审计记录 jti 的不可逆摘要。若未来需要强制单次使用或即时吊销，必须提交新的最小状态 ADR。

### MCP 执行

1. Agent Adapter 负责将当前 Turn 的短期 Token 注入 Provider 原生 MCP 配置或请求 Header；Token 不进入公共
   OpenAPI、领域模型、消息历史、事件 payload 或前端。
2. MCP handler 同时验证工作负载身份和用户委托能力，有效权限是：

   ```text
   用户委托 ∩ MCP allowlist ∩ 工具风险策略 ∩ 工作负载凭据能力
   ```

3. Knowledge 读取工具要求 read；Playbook 启动要求 write；高风险写工具要求 admin。模型提供的 Folder 必须与
   Token 完全一致。
4. Provider 固定版本如果不能按 Turn 注入 Token，该 Provider 的 Folder-scoped MCP 能力返回
   `capability_unavailable`。不得回退到固定 Service Account 代表多用户。
5. 现有固定 Actor + Folder allowlist 仅保留给显式 single-actor 部署。多用户开关启用时检测到固定模式必须启动
   失败或不注册 Folder-scoped MCP。

### Approval 目标事实

1. 浏览器正文只提交 approval ID、decision、reason 和并发字段。Folder Header 只是请求目标，Plugin Backend
   可以先校验，但 Control Plane 仍必须与 Provider 恢复的真实 Folder 比较。
2. Provider-native Approval/tool-call metadata 必须保存不可变目标：Session/Turn、tool/action、目标资源、Folder、
   required access、risk 和 revision。
3. Provider 没有完整 metadata 时，可以把 Control Plane 签名的不可变 target envelope 存在 Provider 原生
   Approval 记录旁。该 envelope 只证明目标绑定，不是执行权限，不能由浏览器回传，也不建立 Aegis Approval 表。
4. Resolve 时重新读取 Approval 和 owner，验证 target/revision/state，实时检查 Folder 权限，再签发新的短期
   委托能力执行。
5. 无法恢复可信目标时 approve 返回 `capability_unavailable`。Reject 只有在 Provider 能证明 Session owner 且
   不产生目标副作用时可以保留；否则同样不可用。用户始终可以取消当前 Turn。

## Provider 过渡行为

- Codex：当前内存 pending request 不满足持久目标要求。完成 metadata/envelope 与重启恢复合同前禁用真实 approve。
- OpenCode 1.18.18：维持 ADR 0006 的 approval `capability_unavailable`。
- 单 Actor：可以继续验证会话和只读工具；写工具仍受固定 Folder allowlist 和显式部署开关限制，不能作为多用户
  验收结果。

## 结果

- Plugin Backend 保持 Grafana-specific 授权边界，Control Plane 只消费 Provider-neutral 断言。
- Agent 工具不会因为固定 Service Account 获得超过当前用户的权限。
- Approval 创建时授权不能被复用到处理时，浏览器状态不能替代目标事实。
- Provider 能力不足会显式不可用，不通过内存或数据库模拟。

## 验收门禁

- Token 过期、签名错误、未知 kid、audience/tool/Folder/Turn 不匹配全部拒绝。
- View 用户不能执行 write/admin；Edit 不能执行 admin；工作负载 allowlist 能进一步衰减权限。
- 用户权限在 cache + TTL 窗口后撤销生效，高风险审批处理时立即重新查询。
- Agent Provider 重启后能从原生事实恢复 Approval target；不能恢复的 Provider 明确不可用。
- 日志、事件、Provider 消息历史和前端均不出现原始委托 Token。
