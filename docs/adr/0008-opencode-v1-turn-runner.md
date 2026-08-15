# ADR 0008：OpenCode 使用 V1 执行 Agent Turn

- 状态：接受
- 日期：2026-08-15
- 适用范围：OpenCode 1.18.18 Agent Adapter

## 背景

OpenCode 1.18.18 的 V2 Session Runner 对 DeepSeek 凭证解析不稳定，并且已连接的远程 MCP
工具不会稳定注入 V2 Session。V1 `prompt_async` 与全局 `/event` 已在隔离环境中验证可以
执行 DeepSeek、Grafana MCP 和 Canvas MCP。

当前 Aegis 不保存 Session 影子表，Session ID 幂等依赖 V2 创建接口接受调用方提供的 ID。
因此不能把 Session 创建也改成 V1：V1 创建接口会忽略调用方 ID 并生成新的 Provider ID。

## 决策

1. V2 只用于创建调用方拥有的 Session，以及创建冲突后的原生读取/模型绑定。
2. V1 用于 Prompt、MCP 工具执行、全局事件、Session/Message 读取、取消、重命名、归档和删除。
3. V1 全局事件流在 Adapter 内按 Session 和当前 user message 过滤，不向公共契约暴露 Provider
   事件 ID、工具参数中的 Provider ID 或全局事件细节。
4. V1 没有 V2 的 `after` 事件回放游标。断线恢复以 Provider 的 Session/Message 快照为准；Aegis
   不新增 Event Store 或 Session 映射表。
5. Canvas SQLite、MCP 工具契约和前端公共 API 不变。

## 结果

- Agent 回合绕开 V2 Session Runner 的 DeepSeek governor 和 V2 MCP 注入问题。
- V1 事件映射必须覆盖文本增量、工具 pending/running/completed/error 和 turn 终态。
- OpenCode Adapter 继续是唯一理解 V1/V2 私有协议的边界；Control Plane 及前端不感知协议选择。
