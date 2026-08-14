# ADR 0002：Agent Session 公开标识

- 状态：接受
- 日期：2026-08-13

## 背景

OpenCode v1.18.18 的 V2 Session API 接受调用方提供的 `ses_` ID，可以直接保存 Aegis
公开 ID。Codex App Server 0.144.4 的 `thread/start` 只返回 Codex 生成的 UUIDv7，且没有
可用于保存 Aegis ID 的通用 metadata。直接把 UUID 加前缀会向公共契约泄漏 Provider ID；
增加映射数据库则违背 Control Plane 无状态边界。

## 决策

1. OpenCode Adapter 使用调用方生成的 Aegis `ses_` ID，依赖其原生 create-if-absent 语义。
2. Codex Adapter 用部署密钥对 UUID 的 16 字节形式做确定性认证加密，生成满足公共契约的
   `ses_` ID。该 ID 可逆但不暴露 UUID，也不需要映射表。
3. 加密采用 AES-256-GCM；nonce 由 HMAC-SHA-256(key, UUID) 派生。Codex UUIDv7 具有高熵，
   不同 UUID 的 nonce 碰撞概率可忽略，同一 UUID 始终生成同一公开 ID。
4. 部署必须备份 ID 密钥，并以只读文件挂载。当前版本不允许原地轮换；丢失密钥会使既有
   Codex Session 无法通过旧公开 ID 访问。支持 keyring 的轮换需要后续 ADR 和迁移窗口。
5. Provider UUID、OpenCode SDK 类型和加密细节只存在于 adapter；公共 API 仍只接受
   `BusinessID`。
6. 本 ADR 只解决公开引用转换，不赋予 Control Plane 会话数据所有权。Session、Turn、消息、
   审批和历史仍由 Codex/OpenCode 持久化；加解密 Codec 是无状态 Adapter，不是映射仓库。
7. 首个版本按部署选择单一 Agent Provider，公开 Session ID 不承担同一实例内的跨 Provider
   动态路由。切换 Provider 使用新的部署配置和会话空间；若以后需要并存，另行提交 ADR。
8. 公开 ID 只能解决直接读取某个 Session，不能解决列表授权。多用户部署必须使用 Provider
   原生租户能力或按可信 Actor 范围隔离 Provider 实例/数据目录；不得通过 Aegis 会话影子表
   过滤共享 Provider 中的资源。

## 结果

- 两个 Agent Provider 均不需要 Control Plane 持久化映射。
- Codex ID 在密钥生命周期内跨进程重启保持稳定。
- 密钥成为恢复既有 Codex Session 的必要配置，必须纳入 Secret 备份和恢复演练。
- Provider 数据目录而不是 Control Plane 是会话恢复来源；丢失 Provider 数据时，公开 ID
  Codec 不能恢复已经不存在的 Session。
