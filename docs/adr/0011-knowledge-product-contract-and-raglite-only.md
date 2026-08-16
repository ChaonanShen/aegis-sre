# ADR 0011：Knowledge 产品契约与单一 RAGLite Provider

- 状态：接受，仓库实施完成，发布门禁中
- 日期：2026-08-16
- 实施更新：2026-08-17
- 关联：修订 ADR 0004、ADR 0008 中的 Provider 选择与公共能力部分

## 背景

现有 Knowledge 垂直切片同时适配 RAGLite 和 RAGFlow。虽然两套实现都接入了
`ports.KnowledgeProvider`，但当前公共接口仍包含两种 Provider 能力的并集，例如手工开始/停止索引、
相似度阈值、Provider 解析状态、Chunk 标识和 scope migration。结果是：

- RAGLite 的混合检索分数不能解释为 RAGFlow 相似度，非零 threshold 无法得到一致语义；
- RAGLite 不能安全停止已经运行的索引任务，公共 Stop API 只能返回能力缺口；
- 上传后仍要求用户手工开始索引，Provider 任务模型泄漏为产品交互；
- `Collection`、`RetrievalHit`、`Chunk` 等命名偏向 Provider 协议，而不是 Aegis 产品概念；
- 双 Provider 迫使接口保留不稳定的最大公约数，增加合同测试、迁移、恢复和前端分支成本。

Aegis 的架构目标不是对外提供通用 RAG 抽象，而是为 SRE 工作台提供稳定的知识库、文档、索引状态、
段落读取和受 Folder 授权约束的检索能力。RAGLite 已包含解析、切分、Embedding、混合检索和 metadata
过滤；Aegis 只需要围绕它建立产品控制面和必要适配。

## 决策

### 1. 单一 Provider

1. Aegis Knowledge 只支持固定版本的 RAGLite sidecar，不再支持运行时选择 RAGFlow。
2. 删除目标态中的 Provider registry、`AEGIS_KNOWLEDGE_PROVIDER` 选择和 RAGFlow 专属配置。
3. Control Plane 仍只依赖 `ports.KnowledgeProvider`；RAGLite、DuckDB、SQLite、模型和内部 REST 类型只存在于
   `internal/adapters/raglite`、`internal/adapters/raglite/sidecar` 与部署层。
4. RAGFlow 退出遵守根目录删除规范：先停止新增写入并完成数据迁移、对账和回退窗口；旧实现保留一到两个发布周期的
   只读或可回退能力。确认无生产数据时，也必须记录依据并取得原作者确认后才能缩短窗口。

单一实现不意味着可以把 RAGLite 类型提升为公共类型。未来如果重新引入其他实现，必须先提交 ADR，证明当前产品契约
无法满足需求；不得恢复按 Provider 能力并集设计接口的方式。

### 2. Knowledge Base 产品能力

首版公共 Knowledge Base 只包含：

```text
id, name, folder_uid, created_at, updated_at
```

公共操作为：

```text
create, list, get, update, delete
```

首版不包含 active/disabled。Knowledge Base 删除要求 Folder Admin，并且只允许删除空 Knowledge Base；非空删除返回
稳定冲突，不做隐式级联。跨 Folder 迁移、legacy scope migration 和 Provider 原生 dataset 状态不进入首版公共模型。

### 3. Document 产品能力

Document 公共字段至少包含：

```text
id, knowledge_base_id, name, media_type, size, sha256,
service, tags, index_status, failure_reason?, created_at, updated_at, indexed_at?
```

其中 `index_status` 只有：

```text
queued | indexing | ready | failed
```

公共操作为：

```text
upload, list, get, update_metadata, retry_index, delete, download
```

不提供通用 start/stop indexing、Provider job ID、Provider Chunk ID 或 Provider 状态。上传成功必须持久化原文件、
Document 和内部索引任务，返回状态为 `queued`；用户不需要再次手工启动索引。

### 4. 索引状态机

状态机固定为：

```text
upload -> queued -> indexing -> ready
                           \-> failed -> retry -> queued
```

约束如下：

1. worker 只能通过持久化条件更新取得 queued 任务，并把 Document 转为 indexing。
2. 成功写入完整索引后转为 ready；失败转为 failed，并写入经过脱敏、可展示的 `failure_reason`。
3. sidecar 重启后必须清理或对账半成品，把遗留 indexing 任务安全重新排队；超过内部重试上限后进入 failed，不能无限循环。
4. `retry_index` 是幂等产品操作：failed 转为 queued；queued/indexing/ready 返回当前状态，不重复创建任务。
5. queued 文档删除时可在 Provider 内部取消尚未运行的私有任务；indexing 文档删除首版返回稳定冲突，不模拟取消成功。
6. Search 只读取 ready Document。queued、indexing、failed Document 不进入检索结果。

### 5. 会影响检索的元数据更新

`service` 和 `tags` 参与检索过滤，修改后必须自动重建索引：

- ready/failed 更新后进入 queued；
- queued 更新只合并到已有任务，worker 读取最新 metadata；
- indexing 期间更新不得让旧 metadata 的任务最终覆盖新值。

RAGLite sidecar 在内部维护 metadata/index generation 或等价 revision。worker 完成时发现 revision 已变化，必须再次进入
queued，而不是把旧索引标记为 ready。revision、attempts 和内部任务 ID 不进入公共契约。

### 6. Document Passage

首版保留产品化的解析段落读取能力，用于 UI 解析结果检查、引用展开和 Knowledge MCP 的受限文档读取：

```text
DocumentPassage {
  ordinal,
  text,
  location?
}
```

公共能力为分页 `list_document_passages`。Passage 不包含 RAGLite Chunk ID、Embedding ID 或数据库主键。
`location` 是可选显示字符串，可以表示标题、段落序号或可靠页码；公共契约不承诺精确 PDF 页码。

### 7. Search

Search 请求只包含：

```text
query
knowledge_base_ids
service?
tags_any?
tags_all?
limit
```

语义如下：

1. `knowledge_base_ids` 必须全部属于当前可信 Tenant/Org/Folder；任一资源越权时整次请求失败，不静默过滤。
2. `service` 规范化后精确匹配；tag 去空白、去重，并分别按任意命中和全部命中处理。
3. 结果数组顺序就是相关性顺序。公共响应不返回 threshold、相似度百分比或必须可跨版本比较的数值 score。
4. 每项引用至少包含 `document_id`、`source_name`、有界 `excerpt` 和可选 `location`。
5. Adapter 必须验证结果仍属于请求的 Knowledge Base 和 Folder，越界结果 fail-closed。

### 8. 幂等和不确定写入

Knowledge Base 创建和 Document 上传继续使用稳定公共 ID 与 `Idempotency-Key`：

- 同一 key、相同 payload 返回已有资源；
- 同一 key、不同 payload 返回稳定幂等冲突；
- 无法确认结果时返回 `provider_result_unknown`，调用方按稳定 ID 查询对账，不自动重复提交写入。

RAGLite sidecar 的 SQLite 唯一约束、SHA-256 和持久化 manifest 负责该语义。Control Plane 不新增幂等或任务影子表。

### 9. 授权和事实来源

Knowledge Base 是 Folder-owned 根资源；Document、Passage、索引状态和 Search 引用继承父 Knowledge Base 的 Folder。
Plugin Backend 和 Control Plane 继续按 read/write/admin 两层校验：

- read：list/get/search/passage/download；
- write：create/update/upload/retry、Document delete；
- admin：删除空 Knowledge Base。

RAGLite sidecar 的 `provider.sqlite` 是 Knowledge Base、Document 和索引任务生命周期的事实来源；RAGLite DuckDB 是
Passage、Embedding 和检索索引的事实来源；`originals/` 是原文件事实来源。Control Plane 不保存副本。

## 不进入首版公共模型

- threshold；
- “相关性分数等于多少百分比”；
- 停止正在运行的索引；
- Provider 原始 job ID；
- RAGLite/RAGFlow 名称；
- Provider 私有 Chunk ID；
- 精确 PDF 页码强承诺；
- 跨 Folder 迁移和 legacy scope migration；
- 独立 Runbook、Service Catalog 或批量 Import Task 模型。

人类 Runbook 首版仍作为 Knowledge Document 和标签存在；可执行流程继续只使用原生 Dagu Playbook。

## 结果

- Knowledge 公共契约由产品能力决定，不再受两个 Provider 的差异牵引。
- 前端只展示自动索引状态和失败重试，不再要求用户理解 Provider 任务。
- RAGLite sidecar 承担持久化索引队列、并发 generation、恢复和幂等对账；这属于 Provider 自有状态，不改变
  Control Plane 无状态边界。
- 删除 RAGFlow 会减少部署、测试和迁移复杂度，但在回退窗口关闭前仍需保留明确、只读或可恢复的旧路径。
- 对外 REST、MCP、领域类型和前端 Gateway 必须一起迁移，禁止长期维护新旧两套 Knowledge 公共模型。

详细实施顺序和验收门禁见
[Knowledge 产品契约收敛与 RAGLite 单 Provider 执行计划](../knowledge-product-contract-execution-plan.md)。
