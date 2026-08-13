# ADR 0001：Dagu Playbook 写入归属

- 状态：接受
- 日期：2026-08-13

## 背景

Dagu YAML 是 Playbook 的唯一事实来源。Aegis UI 和 GitOps 如果同时修改同一个 DAG 文件，
会产生无法由无状态 Control Plane 可靠解决的覆盖冲突；为此增加版本表或 YAML 影子副本又会
制造第二事实来源。

## 决策

1. Aegis UI/API 只创建和修改文件名为 `pbk_<public-id>.yaml` 的 DAG；公开 ID 直接由文件名
   推导，不建立 Provider ID 映射。
2. GitOps 管理的 DAG 不使用 `pbk_` 命名空间。Dagu Adapter 不在 Aegis 列表中暴露它们，
   也不接受通过 Aegis API 修改或删除它们。
3. Aegis 对原生 YAML 做透传写入和只读投影，不保存规范化副本，也不从前端图模型反向生成
   Dagu YAML。
4. 需要把 GitOps DAG 交给 UI 管理时，必须通过一次显式导入创建新的 `pbk_` DAG；原文件
   保持不变。反向交接则先停止 UI 写入，再由仓库接管新名称，不能让两个写入方共享文件名。
5. 当前版本不支持同一 DAG 的混合写入。以后若 Dagu 提供稳定的原生 revision/ETag 与所有权
   metadata，可通过新的 ADR 增加显式接管流程，仍不得引入 YAML 影子表。

## 结果

- Dagu 仍是定义、运行、步骤和 Artifact 的唯一持久化引擎。
- 命名空间在写入前即可判定所有权，Control Plane 无需数据库或锁服务。
- GitOps DAG 默认不会出现在 Aegis UI；这是避免隐式双写的有意限制。

