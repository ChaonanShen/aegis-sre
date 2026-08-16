# Knowledge 产品契约收敛与 RAGLite 单 Provider 执行计划

- 状态：待实施
- 日期：2026-08-16
- 决策基线：[ADR 0011](adr/0011-knowledge-product-contract-and-raglite-only.md)
- 架构基线：[Aegis SRE 基本架构](architecture.md)

## 1. 目标

本计划把现有双 Provider Knowledge 垂直切片收敛为一个由产品能力定义、仅由 RAGLite 实现的稳定闭环：

```text
Grafana Plugin
  -> Plugin Backend / Folder RBAC
  -> Control Plane REST
  -> ports.KnowledgeProvider（产品契约）
  -> RAGLite adapter
  -> RAGLite sidecar
  -> provider.sqlite + raglite.db + originals/
```

交付完成后，用户能够在有权 Folder 内创建 Knowledge Base、上传文档并自动进入索引队列，查看
queued/indexing/ready/failed 状态，在失败后重试，管理 metadata，读取解析段落，下载原文，并按一个或多个
Knowledge Base、service 和 tags 检索有序引用。

本计划不重新实现解析、切分、Embedding、向量检索或生成式 RAG；不在 Control Plane 建立 Knowledge、任务或幂等
影子数据库。

## 2. 当前基线和主要差距

当前已经具备：

- `ports.KnowledgeProvider`、Knowledge REST、Knowledge MCP 和真实前端 Gateway；
- Plugin Backend 与 Control Plane 的 Folder read/write/admin 授权；
- RAGLite sidecar、SQLite manifest、DuckDB、原文件目录和单 writer；
- RAGFlow adapter 与显式回退部署；
- 公共 ID、scope fingerprint、错误净化和基础单元测试。

需要替换的现状：

- 公共 Port 使用 Collection、Chunk、Retrieve 等 Provider 导向命名；
- 上传后为 pending，用户还需手工 start indexing；
- start/stop、threshold、score、Provider Chunk ID 和精确页码进入公共契约；
- RAGLite 与 RAGFlow 对 disabled、threshold、幂等重试和取消的行为不同；
- metadata 更新期间缺少 generation 收敛，存在旧索引覆盖新 metadata 的风险；
- 前端对 pending 无限轮询，默认发送 RAGLite 不支持的非零 threshold；
- 真实浏览器到 RAGLite 的文件、权限、恢复和质量 E2E 尚未成为发布门禁。

## 3. 目标公共契约

### 3.1 领域类型

目标类型命名：

| 现有名称 | 目标名称 | 说明 |
| --- | --- | --- |
| `KnowledgeCollection` | `KnowledgeBase` | 产品根资源 |
| `KnowledgeCollectionRef` | `KnowledgeBaseRef` | 只含公共 `kbs_` ID |
| `KnowledgeDocument` | `Document` 或 `KnowledgeDocument` | 保留产品字段和索引状态 |
| `KnowledgeChunk` | `DocumentPassage` | 无 Provider Chunk ID |
| `RetrievalInput` | `KnowledgeSearchInput` | 无 threshold |
| `RetrievalHit` | `KnowledgeCitation` | 有序引用，无百分比分数 |

`DocumentIndexStatus` 只允许：

```text
queued, indexing, ready, failed
```

### 3.2 Port 方法

目标 `KnowledgeProvider`：

```go
type KnowledgeProvider interface {
    Check(context.Context) error

    ListKnowledgeBases(context.Context, domain.ActorContext, domain.PageRequest) (domain.Page[KnowledgeBase], error)
    GetKnowledgeBase(context.Context, domain.ActorContext, KnowledgeBaseRef) (KnowledgeBase, error)
    CreateKnowledgeBase(context.Context, domain.ActorContext, CreateKnowledgeBaseInput) (KnowledgeBase, error)
    UpdateKnowledgeBase(context.Context, domain.ActorContext, KnowledgeBaseRef, UpdateKnowledgeBaseInput) (KnowledgeBase, error)
    DeleteKnowledgeBase(context.Context, domain.ActorContext, KnowledgeBaseRef) error

    ListDocuments(context.Context, domain.ActorContext, KnowledgeBaseRef, DocumentFilter, domain.PageRequest) (domain.Page[KnowledgeDocument], error)
    GetDocument(context.Context, domain.ActorContext, DocumentRef) (KnowledgeDocument, error)
    UploadDocument(context.Context, domain.ActorContext, KnowledgeBaseRef, DocumentFile) (KnowledgeDocument, error)
    UpdateDocumentMetadata(context.Context, domain.ActorContext, DocumentRef, DocumentMetadata) (KnowledgeDocument, error)
    RetryDocumentIndex(context.Context, domain.ActorContext, DocumentRef) (KnowledgeDocument, error)
    DeleteDocument(context.Context, domain.ActorContext, DocumentRef) error
    DownloadDocument(context.Context, domain.ActorContext, DocumentRef) (DocumentDownload, error)
    ListDocumentPassages(context.Context, domain.ActorContext, DocumentRef, domain.PageRequest) (domain.Page[DocumentPassage], error)

    Search(context.Context, domain.ActorContext, KnowledgeSearchInput) ([]KnowledgeCitation, error)
}
```

这是目标结构示意；实现时可以保留包内一致的 `Knowledge` 前缀，但不得继续暴露 RAGLite 或 RAGFlow 私有类型。

### 3.3 REST 目标

保留：

```text
GET    /api/v1/knowledge-bases
POST   /api/v1/knowledge-bases
GET    /api/v1/knowledge-bases/{knowledge_base_id}
PUT    /api/v1/knowledge-bases/{knowledge_base_id}
DELETE /api/v1/knowledge-bases/{knowledge_base_id}

GET    /api/v1/knowledge-bases/{knowledge_base_id}/documents
POST   /api/v1/knowledge-bases/{knowledge_base_id}/documents
GET    /api/v1/knowledge-bases/{knowledge_base_id}/documents/{document_id}
PUT    /api/v1/knowledge-bases/{knowledge_base_id}/documents/{document_id}
DELETE /api/v1/knowledge-bases/{knowledge_base_id}/documents/{document_id}
GET    /api/v1/knowledge-bases/{knowledge_base_id}/documents/{document_id}/content
GET    /api/v1/knowledge-bases/{knowledge_base_id}/documents/{document_id}/passages
POST   /api/v1/knowledge-bases/{knowledge_base_id}/documents/{document_id}:retry-index

POST   /api/v1/knowledge:search
```

删除目标：

```text
POST .../{document_id}:index
POST .../{document_id}:stop
GET  .../{document_id}/chunks
POST .../{knowledge_base_id}/scope-migrations
```

文档元数据更新统一使用 `PUT`。现有 `PATCH` 作为兼容入口时必须标记移除版本，不能继续让 OpenAPI 与真实 Gateway
不一致。

### 3.4 Search 请求和响应

请求：

```json
{
  "query": "如何恢复 checkout 服务",
  "knowledge_base_ids": ["kbs_..."],
  "service": "checkout",
  "tags_any": ["prod", "runbook"],
  "tags_all": ["approved"],
  "limit": 5
}
```

响应：

```json
{
  "citations": [
    {
      "document_id": "doc_...",
      "source_name": "checkout-recovery.md",
      "excerpt": "先确认连接池和数据库健康状态……",
      "location": "heading: 恢复步骤"
    }
  ]
}
```

不返回 threshold、score、Provider Chunk ID。`location` 可省略。

## 4. 分阶段执行

### P0：冻结决策与兼容窗口

- [x] 接受 ADR 0011。
- [ ] 确认 RAGFlow 代码和部署的原作者。
- [ ] 盘点是否存在需要保留的 RAGFlow 生产/预生产数据、部署配置、密钥、卷和外部调用方。
- [ ] 记录停止 RAGFlow 写入的版本、只读/回退窗口和最终删除版本。
- [ ] 确认现有 v1 user-scoped Knowledge 数据数量；目标公共 API 不保留 scope migration，遗留数据通过受控迁移工具或
  归档流程处理。
- [ ] 冻结首版格式：先保证 PDF、Markdown、TXT；DOCX/HTML 只有真实验收通过后才开放。
- [ ] 冻结大小上限、service/tag 规范化、`tags_any/tags_all`、删除冲突和错误码。

退出标准：不存在未决定的状态机、删除、幂等、过滤或 RAGFlow 退出语义。

### P1：公共领域模型、Port 与 OpenAPI 收敛

- [ ] 把 `Collection` 命名迁移为 `KnowledgeBase`，删除公共 status/read_only Provider 投影。
- [ ] 把 Document 状态收敛为 queued/indexing/ready/failed，增加可选 `failure_reason`、`indexed_at`。
- [ ] 用 `DocumentPassage` 取代 `KnowledgeChunk`，只保留 ordinal、text、可选 location。
- [ ] 用 `KnowledgeSearchInput` 和 `KnowledgeCitation` 取代 Retrieval 类型，删除 threshold 和 score。
- [ ] 从 Port 删除 StartIndexing、StopIndexing、MigrateCollectionScope 和 Provider Chunk 语义。
- [ ] 增加 RetryDocumentIndex 和 ListDocumentPassages。
- [ ] 冻结 `PUT` 文档 metadata 更新并生成 Go/TypeScript 契约。
- [ ] 删除或明确废弃未实现、没有事实来源的 `/services` 公共契约。
- [ ] 更新 `api/events.schema.json`；如果索引只使用轮询且没有新事件，则记录无需新增事件的理由。

测试：

- [ ] OpenAPI lint、代码生成和生成物零 diff。
- [ ] 领域状态、输入边界和 JSON schema 测试。
- [ ] 结构测试证明公共模型不含 RAGLite/RAGFlow、job ID、Chunk ID、threshold、score。

退出标准：REST、Port、领域类型和前端生成类型只表达产品能力。

### P2：RAGLite sidecar 状态机和持久化

- [ ] 修改 SQLite schema，使上传事务创建 Document 和唯一 queued index job。
- [ ] 上传文件、Document manifest 和任务创建失败时实现可恢复补偿；不留下无任务 queued 文档。
- [ ] worker 用条件更新 claim queued 任务，并执行 queued -> indexing -> ready/failed。
- [ ] 增加 metadata/index generation，合并 queued 更新并处理 indexing 期间的后续修改。
- [ ] metadata 更新对 ready/failed 自动排队；queued 合并；indexing 完成后发现新 generation 时再次排队。
- [ ] retry_index 实现为幂等状态转换，不暴露内部 job。
- [ ] 启动时恢复遗留 indexing、清理半成品，限制自动 attempts，最终失败可由用户重试。
- [ ] queued 删除取消内部未运行任务；indexing 删除返回稳定 conflict。
- [ ] Knowledge Base 非空删除返回稳定 conflict，不级联。
- [ ] Search 强制只返回 ready Document，并验证 scope、Knowledge Base 和 service/tag 过滤。
- [ ] Passage 映射为 ordinal/text/location，不返回 DuckDB Chunk ID。
- [ ] 相同幂等键和相同 payload 返回已有资源；异 payload 返回 idempotency conflict。
- [ ] 内部 REST schema、错误码、响应大小和 job 状态机固定版本。

迁移：

- [ ] 为 provider.sqlite 增加前向 schema migration；旧 pending 映射为 queued，并为其补建唯一任务。
- [ ] 旧 ready/failed 数据保持原状态；旧 indexing 在首次启动时进入恢复流程。
- [ ] migration 带 checksum，重复运行幂等，未知新 schema 版本 fail-closed。

退出标准：单 sidecar 在重启、重复请求和 metadata 并发下保持状态机一致。

### P3：Go adapter 与 Control Plane

- [ ] RAGLite adapter 实现新 Port，删除双 Provider 分支和能力差异映射。
- [ ] Control Plane 装配直接创建 RAGLite adapter；移除运行时 Provider 选择。
- [ ] 上传返回 queued Document，不再提供 start/stop。
- [ ] metadata 更新返回最新状态，retry 返回当前 Document。
- [ ] Passage、Search 和下载在每次请求中重新验证父 Knowledge Base Folder。
- [ ] Search 对任一越权 Knowledge Base 整体失败，不静默丢弃。
- [ ] 增加 service/tag 长度、数量、规范化和组合过滤限制。
- [ ] 统一最大文件大小；服务端仍是最终限制，不能只依赖浏览器。
- [ ] `provider_result_unknown` 保留稳定查询对账路径。
- [ ] 下载和 Passage 响应设置 no-store、大小限制和安全 Content-Disposition。
- [ ] 日志只记录 ID、状态、耗时、request/trace 和授权 scope，不记录正文、query、Passage 或原文件内容。

退出标准：Control Plane 不包含 RAGFlow import、配置、类型或运行时选择，且不保存 Provider 状态副本。

### P4：Knowledge MCP

- [ ] `knowledge.search` 删除 threshold，增加 service、tags_any、tags_all，并返回有序 citations。
- [ ] `knowledge.get_document` 改用 Document + 分页 Passage，继续限制单 Passage、数量和总字节数。
- [ ] `knowledge.list_sources` 映射 queued/indexing/ready/failed。
- [ ] MCP 不返回 score、Provider Chunk ID、job ID 或内部路径。
- [ ] MCP 只检索 ready Document；指定越权 Knowledge Base 时整次拒绝。
- [ ] 保持固定 Actor + Folder allowlist 的当前边界；逐 Turn 多用户委托不属于本计划。

退出标准：MCP 与 REST 使用同一产品 Port 和过滤语义，没有独立检索实现。

### P5：Grafana Plugin 产品闭环

- [ ] real 模式只展示 Knowledge Base、Documents、Search 和 Passage；不恢复 fixture Service/Import/独立 Runbook 模型。
- [ ] 上传后直接显示 queued，不再显示 pending 或“开始索引”按钮。
- [ ] 只在 queued/indexing 时有限轮询；离开 Folder/Knowledge Base 或组件卸载时取消请求。
- [ ] failed 展示脱敏原因和“重试索引”；不显示停止按钮。
- [ ] metadata 保存后立即显示 queued/indexing，防止用户误以为旧索引仍有效。
- [ ] Passage 分页加载；location 为空时显示段落序号，不显示“第 0 页”。
- [ ] Search 支持一个或多个 Knowledge Base、service、tags_any/tags_all 和 limit。
- [ ] Search 结果不显示百分比分数，引用可打开 Document 和对应 Passage。
- [ ] 页面消费 `/capabilities`，区分未配置、降级和可用，不以第一次列表 503 代替能力状态。
- [ ] 错误映射覆盖 forbidden、conflict、capability_unavailable、provider_unavailable、provider_result_unknown；
  不确定写入提示先刷新对账。
- [ ] 删除非空 Knowledge Base、删除 indexing Document 显示明确冲突，不提供危险级联确认。
- [ ] View/Edit/Admin 控件继续只作为体验提示，服务端保持最终授权。

兼容：

- [ ] 旧 fixture UI 只保留在显式 fixture 模式；物理删除前确认作者并记录兼容窗口。
- [ ] real 模式不得读取 fixture local/session storage。

退出标准：普通用户无需理解索引 job；完整交互只有上传、观察状态、失败重试、搜索和引用阅读。

### P6：RAGFlow 数据迁移、只读窗口与代码退出

- [ ] 停止 RAGFlow 新增写入，冻结镜像、配置和数据快照。
- [ ] 导出原文件、公共 Knowledge Base/Document ID、Folder scope、service、tags、SHA-256 和时间信息。
- [ ] 导入 RAGLite provider.sqlite/originals，并用新状态机重新索引；禁止复制 RAGFlow 私有索引。
- [ ] 对账每个 Folder 的 Knowledge Base、Document、SHA-256、metadata、ready/failed 和检索引用。
- [ ] 生成迁移报告并记录无法迁移、重复、孤儿和 legacy 数据的处理决定。
- [ ] 在一到两个发布周期内保留只读或显式回退能力；新公共 API 不再新增 RAGFlow 功能。
- [ ] 回退演练确认不会让 RAGLite 与 RAGFlow 同时写同一业务数据。
- [ ] 窗口结束、作者确认、数据归档和发布观察完成后，删除 `internal/adapters/ragflow`、RAGFlow Compose、旧配置、
  文档和测试。

退出标准：运行仓库和部署只包含 RAGLite；历史数据、回退关闭和删除依据可审计。

### P7：安全、恢复和可观测性

- [ ] 固定 RAGLite、Python、DuckDB、Pandoc、模型、扩展和最终镜像 digest。
- [ ] RAGLite 完整依赖、sidecar 测试和 Ruff 固定在 Linux/amd64 容器执行；Intel macOS 因
  `onnxruntime 1.28.0` 无 x86_64 wheel，只运行不依赖真实 Runtime 的轻量测试，不能修改锁文件绕过。
- [ ] 模型和 FTS/VSS 扩展离线预热，稳态启动和首次索引不访问公网。
- [ ] 文件扩展名、MIME、实际内容、畸形文件和解析超时采用一致 fail-closed 策略。
- [ ] 对 PDF/DOCX 等复杂格式测试内存、CPU、临时磁盘和压缩炸弹限制；未验收格式不在 UI 开放。
- [ ] 增加队列深度、queued 等待时间、索引耗时、失败率、恢复次数、DuckDB/SQLite/原文件磁盘水位指标。
- [ ] 演练 provider.sqlite、raglite.db、originals、模型 revision 和 Knowledge ID key 的一致性备份恢复。
- [ ] 故障注入覆盖上传中断、sidecar 退出、半成品索引、磁盘满、删除中断、超时和不确定写入。
- [ ] 恢复后验证公共 ID、Folder scope、下载、Passage 和 Search 不变。

退出标准：任何失败不会让越权数据可见、不会静默丢失原文件，并且可通过稳定 ID 对账。

### P8：真实 E2E、质量门禁与发布

- [ ] 新增真实浏览器 E2E：Plugin -> Plugin Backend -> Grafana authz -> Control Plane -> RAGLite。
- [ ] 覆盖 Viewer、Editor、Admin 三用户和至少三个 Folder；权限撤销、伪造 Folder、跨 Folder ID 全部 fail-closed。
- [ ] 覆盖上传 -> queued -> indexing -> ready -> Passage -> Search -> 下载 -> 删除。
- [ ] 覆盖 failed -> retry、metadata 更新自动重建、并发 metadata 更新和重启恢复。
- [ ] 使用 30～50 份真实运维文档和至少 30 条中文标注问题执行质量门禁。
- [ ] 解析成功率不低于 95%，人工标注证据 Top 5 命中率不低于 85%，越权结果和删除残留均为 0。
- [ ] 记录索引吞吐、P50/P95 Search 延迟、RSS、CPU、磁盘增量和冷/热启动时间。
- [ ] 预生产观察至少一个完整发布周期，没有未解释的索引丢失、状态卡死、越权、恢复失败或明显质量回归。

退出标准：Knowledge 可以作为正式能力启用；未配置 Knowledge 时 Agent 和 Playbook 基础栈仍独立可用。

## 5. 测试矩阵

| 层级 | 必须覆盖 |
| --- | --- |
| Domain/Port | 四态状态机、过滤语义、公共类型无 Provider 泄漏 |
| Sidecar repository | schema migration、唯一 queued job、generation、幂等、条件状态转换 |
| Sidecar worker | 自动索引、重试、重启恢复、半成品清理、并发 metadata 更新 |
| RAGLite backend | PDF/MD/TXT、Passage、service/tags、ready-only Search、删除残留 |
| RAGLite runtime | Linux/amd64、完整 `uv.lock`、ONNX Runtime/RAGLite/llama.cpp 导入、sidecar pytest 与 Ruff |
| Go adapter | wire schema、认证、超时、响应上限、错误净化、ID/scope 映射 |
| HTTP | read/write/admin、分页、上传、retry、Passage、Search、冲突与对账 |
| MCP | allowlist、越权、bounded Passage/citations、无 score/job/chunk ID |
| Frontend | Folder 切换、轮询取消、四态 UI、失败重试、多 KB Search、错误映射 |
| E2E | 真实 Grafana RBAC、真实文件、重启、备份恢复、权限撤销 |

## 6. 稳定错误码

至少保留或增加：

```text
invalid_argument
unauthenticated
forbidden
not_found
conflict
idempotency_conflict
knowledge_base_not_empty
document_is_indexing
provider_unavailable
provider_result_unknown
capability_unavailable
```

`capability_unavailable` 只用于 Knowledge 整体未配置或明确未验收格式，不再用于 threshold、停止索引等已经从公共契约
删除的操作。

## 7. 发布与回滚

发布顺序：

1. 先发布 sidecar schema/state machine，确保能读取旧数据并兼容旧 Control Plane 请求。
2. 再发布 Control Plane 新 Port/REST/MCP，同时保留有期限的 HTTP 兼容入口。
3. 最后发布 Plugin 新 UI，停止调用 start/stop/chunks/threshold。
4. 确认没有旧客户端后删除兼容入口。
5. RAGFlow 只读/回退窗口独立于 HTTP 兼容窗口，必须满足 ADR 0011 的删除门禁。

回滚必须使用匹配的 sidecar、Control Plane 和 Plugin 版本。provider.sqlite schema 只做向前兼容迁移；回滚前恢复一致性
备份，不能让旧 worker 读取无法理解的新状态。任何回滚都不得重新开启 RAGFlow 和 RAGLite 双写。

## 8. 完成定义

只有同时满足以下条件，本计划才可标记完成：

- 公共代码和 OpenAPI 不含 RAGFlow、threshold、score、start/stop、job ID、Provider Chunk ID；
- 上传自动 queued，索引四态、失败重试和 metadata generation 行为可重复验证；
- Passage 和 Search 使用产品类型，且只读取 ready Document；
- RAGFlow 数据与删除窗口已完成并有记录；
- 真实权限 E2E、故障恢复、备份恢复和质量门禁全部通过；
- README、架构、授权、部署和运行手册与真实实现一致；
- 未配置或故障的 Knowledge 不会静默回退 fixture，也不破坏 Agent/Playbook 已完成链路。
