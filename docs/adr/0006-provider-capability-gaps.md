# ADR 0006：Provider 能力缺口处理

- 状态：接受
- 日期：2026-08-14

## 背景

Agent Provider 的公共接口可能包含某个 Provider 当前没有的能力。OpenCode `1.18.18`
没有经过验证的 unarchive 接口，approval continuation 也无法从 Aegis 公共 approval ID
可靠定位到 OpenCode permission。为补齐表面功能而在 Control Plane 或前端维护替代状态，
会制造第二事实来源并掩盖 Provider 限制。

## 决策

1. Provider 没有原生能力时不接入，不模拟成功，不用内存、local storage 或数据库补齐状态。
2. 公共接口保留稳定的 `capability_unavailable` 错误，前端显示明确不可用状态。
3. 能力缺口、固定 Provider 版本和原因必须记录在对应 ADR/实施计划，并配套 contract test。
4. 未来其他 Provider 可以独立实现该能力；实现必须位于对应 adapter，不能改变公共契约或
   要求所有 Provider 同时支持。
5. 本决策适用于 archive/unarchive、approval、Human Task、Artifact、日志等所有 Provider
   特有能力，不只适用于 OpenCode。

## 当前记录

- OpenCode `1.18.18`：unarchive 暂不接入。
- OpenCode `1.18.18`：approval continuation 暂不接入。
- 这两项不阻塞 Agent 基础会话或 Agent → Playbook MCP 主链路。
