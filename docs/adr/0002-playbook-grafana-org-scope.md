# ADR 0002：Playbook 首版按 Grafana Org 隔离

- 状态：部分被 ADR 0009 取代
- 日期：2026-08-13

本文保留公共 ID 的 Tenant/Org 隔离与历史兼容背景；仅按 Org Role 授权的决策已被
[ADR 0009](0009-playbook-folder-ownership.md) 的 Dagu 原生 Folder labels 取代。

## 背景

Playbook 定义由 Dagu 持久化，Control Plane 不建立资源映射表。原有 `pbk_<hash>` 公共 ID
无法判断资源所属 Grafana Org，导致知道 ID 的其他 Org 可以读取或修改同一 Dagu DAG。
现有 Folder、private/shared 字段来自迁移 fixture，尚未接入 Grafana Folder 权限契约。

## 决策

1. Playbook 管理 API 首版以 Grafana Tenant + Org 为资源作用域。
2. Aegis 管理的 Dagu 文件仍使用 `pbk_<public-id>.yaml` namespace；公共 ID 内嵌
   Tenant + Org 的不可逆摘要，Control Plane 在调用 Provider 前校验该摘要。
3. list 只返回当前 Org 作用域的 Playbook；跨 Org get/update/delete 统一返回 404，避免资源枚举。
4. Grafana Viewer 可以 list/get；Editor 和 Admin 可以 create/update/delete/validate。
5. Playbook 的唯一可写事实来源是原生 Dagu YAML。Folder、private/shared、owner、版本和修订记录
   在没有真实 Provider 语义前不进入 CRUD UI 或公共 Playbook 契约。
6. Dagu REST API 使用 DAG 文件 stem（`pbk_xxx`）；`.yaml` 后缀只描述磁盘文件名，不进入 API 路径。

## 影响

- 迁移 fixture 中没有 Org scope 的旧公共 ID 不会出现在真实列表中，也不能通过真实 CRUD API 修改。
- 如需迁移旧真实数据，应提供一次性、显式的重命名工具；不得静默把无作用域资源归给当前用户。
- 后续接入 Grafana Folder 权限时，需要新的 ADR 说明 scope metadata、授权规则和兼容迁移。
- fixture、自定义 DSL 和旧结构化编辑器先从生产依赖中脱离；按项目删除规范，在真实 E2E、作者确认
  和至少一个发布周期的回退窗口完成后再物理删除。
