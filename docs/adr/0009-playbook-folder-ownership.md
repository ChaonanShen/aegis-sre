# ADR 0009：Dagu Playbook 使用原生 Labels 承载 Folder Ownership

- 状态：接受
- 日期：2026-08-16
- 适用范围：Playbook、Run、Step、Approval、Artifact 和 Playbook MCP
- 取代范围：ADR 0002 中“Playbook 仅按 Grafana Org 授权”的部分；ADR 0001 的 Aegis/GitOps 写入边界继续有效

## 背景

现有 Playbook 已经通过 Control Plane 接入 Dagu 2.13.0，但授权仍停留在 Grafana Org Role：公共 `pbk_` ID
只包含 Tenant/Org 摘要，写操作依赖 Viewer/Editor/Admin，前端也没有发送 Folder context。这不能表达同一 Org
内不同团队对 Playbook、Run、Approval 和 Artifact 的隔离。

Dagu YAML 是 Playbook 唯一事实来源，Control Plane 不能为 Folder ownership 增加映射表。Dagu 2.13.0 的
`dagu schema dag` 已验证顶层 `labels` 是原生字段，支持字符串、map 和数组；`tags` 只是 labels 的废弃别名。
Dagu DAG 列表和详情 API 也能返回原生 labels。现有 Run 已使用 Dagu 原生 label
`aegis.playbook.id=<encoded-id>` 关联 Playbook，因此 Run 可以继续先恢复 Playbook，再读取其 Folder owner。

## 决策

### Playbook 根资源

1. Aegis-managed Dagu YAML 使用以下保留 labels：

   ```yaml
   labels:
     aegis.managed: true
     aegis.owner.kind: folder
     aegis.owner.version: 1
     aegis.folder.uid: <grafana-folder-uid>
   ```

2. `aegis.folder.uid` 是 Folder ownership 的唯一生产事实。公共 ID 中的 Tenant/Org 摘要继续作为兼容性和快速
   过滤，不再单独构成授权证明。
3. 创建 Playbook 时，Adapter 使用已验证的 Actor Folder 注入保留 labels。浏览器和 YAML 不能声明不同 owner。
4. 更新 Playbook 时，Adapter 先读取现有 Dagu YAML，确认其 Folder 与已授权 Folder 一致，再保留原 owner。
   用户 YAML 缺少保留 labels 时由 Adapter 补齐；提交冲突的保留 label 时返回 `invalid_argument`，不能静默迁移。
5. 普通更新不得改变 `aegis.*` 保留 labels。跨 Folder 迁移是独立 Admin 操作，同时校验源和目标 Folder admin，
   并在受审计流程中修改原生 YAML。
6. 非保留的 Dagu labels 仍由用户原生 YAML 管理。Adapter 使用 `yaml.Node` 做最小结构修改，不引入自定义 DSL，
   不把 YAML 转换成第二套 Playbook 模型。

### 子资源继承

1. Run 继续通过 Dagu Run label `aegis.playbook.id` 关联 Playbook。
2. 读取或操作 Run、Step、Human Task、Approval、日志和 Artifact 时，Adapter 必须执行
   `Run -> Playbook ID -> Dagu YAML labels -> Folder`，再与请求授权上下文比较。
3. Run 上的 label 只用于恢复父 Playbook，不能覆盖 Playbook 的 Folder owner。
4. 无法恢复 Playbook、保留 label 缺失/冲突或 Folder 不一致时 fail-closed；公共 Run ID、Step ID 和 Artifact
   path 都不是授权凭据。

### 旧 Playbook 兼容与迁移

1. 没有 `aegis.folder.uid` 的现有 Org-scoped `pbk_` Playbook 不自动归给当前 Folder 或创建者。
2. 部署可以配置唯一 `AEGIS_PLAYBOOK_LEGACY_FOLDER_UID` 作为兼容读取范围。只有对该 Folder 有 read 的用户可以
   查看旧 Playbook 及历史 Run；create/update/delete/start/retry/approval 等写操作全部拒绝。
3. 兼容窗口保留一到两个发布周期。显式迁移会在目标 Folder 下创建带 labels 的新 Playbook，保留旧 YAML 和
   历史 Run 为只读；不原地改名，不移动旧 Run，不删除旧资源。
4. 回滚到旧版本时，新 Playbook 仍是合法原生 Dagu YAML；旧版本可能按 Org 列出它们，但发布回滚前必须通过
   Plugin Backend feature flag 关闭写入口，避免绕过 Folder 授权。
5. 兼容窗口结束后的删除仍需与原作者确认，并记录备份、回退和审计；本 ADR 不授权自动删除。

### 公共契约

1. `Playbook` 和 `PlaybookSummary` 增加 Provider-neutral `folder_uid`，值来自 Dagu 原生 labels。
2. `Run` 不复制独立 Folder owner；通过 `playbook_id` 继承。
3. `internal/ports` 可以表达 Folder UID，但不得出现 Dagu label key、YAML node 或 Dagu SDK 类型。
4. 前端必须提交请求 Folder context；服务端仍从 Dagu 读取 owner 做第二次校验。

## 权限

- list/get、Run/Event/Artifact 读取：Folder read。
- create/update/validate/start/cancel/retry/Human Task：Folder write。
- delete、Approval resolve、跨 Folder 迁移：Folder admin。
- Grafana Org Role 不再直接授权 Playbook 写入。

## 结果

- Dagu YAML 继续是 Playbook 内容和 ownership 的唯一事实来源。
- Folder 删除后，reconciliation 可以从保留 label 恢复 orphan 的原 Folder UID。
- 现有 `pbk_` ID 和 Run label 不需要破坏性重写。
- 用户不能通过编辑 YAML 或公共 ID 改变 owner。
- 旧 Playbook 有明确只读兼容窗口，不需要 ownership 影子表。

## 验收门禁

- `dagu schema dag` 和 `dagu validate` 在固定 2.13.0 上接受注入后的 labels。
- Adapter 测试覆盖 labels map/array/string、保留 label 冲突、缺失 owner、跨 Folder get/list/update/delete。
- Run、SSE、Approval 和 Artifact 测试都从父 Playbook 恢复 Folder。
- 旧 Playbook 只能在 legacy Folder 读取，所有写路径拒绝。
- Dagu 重启后 owner 和历史 Run 仍可恢复，Control Plane 无 ownership 表仍可工作。
