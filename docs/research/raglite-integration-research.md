# RAGLite 接入 Aegis SRE 的详细调研

> 调研日期：2026-08-15  
> 固定版本：RAGLite `1.1.1`（tag `v1.1.1`，commit `6a540e1bd10f80093316deb44e049c1308e9f7e7`，MPL-2.0）  
> 目标：确认“自己补 REST API、原文件落目录”是否仍然是薄适配，及其真实工程边界。

## 结论先行

在允许增加一个 **Python Provider sidecar** 的前提下，RAGLite 比 AnythingLLM 更适合 Aegis：

- RAGLite 负责真正的 RAG 通用能力：PDF/文本转 Markdown、句子与语义切分、Embedding、
  DuckDB FTS/VSS、向量/关键词/混合检索、metadata 过滤和 Chunk 邻接恢复。
- Aegis 不需要实现解析器、切分器或向量算法，只需实现资源生命周期、原文件存储、任务状态、
  内部 REST 鉴权和现有 `KnowledgeProvider` 的协议转换。
- AnythingLLM 少写一个 sidecar，但会引入 Aegis 不使用的聊天、Agent 和 Workspace 产品层；
  RAGLite 的边界更干净，也更容易明确“谁拥有哪类数据”。

这不是“安装一个 Python 包就完成”。RAGLite 是 toolkit，不提供面向本项目的 REST 管理面；
需要新增一个单实例服务。不过这层服务是 **Provider adapter/service**，不是另造 RAG 引擎。

## RAGLite 已经提供什么

RAGLite `1.1.1` 的公开 Python API 包含：

| 能力 | RAGLite 提供的 API/实现 | 说明 |
| --- | --- | --- |
| 文档对象 | `Document.from_path`、`Document.from_text` | 可指定稳定 `id`，metadata 会写入数据库 |
| 文档解析 | `document_to_markdown` | PDF 由 `pdftext` 处理；其他格式需要 `pandoc` extra |
| 切分 | `split_sentences`、`split_chunklets`、`split_chunks` | SaT 句子模型 + 语义分块，不是固定长度切片 |
| 索引 | `insert_documents` | 生成 Document、Chunk、ChunkEmbedding，并维护 FTS/VSS 索引 |
| 检索 | `vector_search`、`keyword_search`、`hybrid_search` | 混合检索使用 RRF 合并 |
| 过滤 | `metadata_filter` | 不同字段 AND，同字段多值 OR；适合 collection/scope/service |
| Chunk 读取 | `retrieve_chunks`、`retrieve_chunk_spans` | 能返回 chunk body、heading、document metadata 和邻接块 |
| 删除 | `delete_documents`、`delete_documents_by_metadata` | DuckDB 删除不是单事务原子操作，且会重建索引 |
| MCP | 内置只读搜索 MCP | 不能替代 Aegis 的授权、CRUD 和公共契约，因此不直接暴露 |

RAGLite 的 DuckDB 表大致包含 `document`、`chunk`、`chunk_embedding`、`metadata`、
`index_metadata` 和评测表。Document 的完整正文不存入数据库，但 Chunk body 会保存；因此
原始文件目录不是重复实现解析，而是为了下载、重新索引和灾备。

## 需要自己实现什么

### 1. Python Provider service

新增一个独立进程，例如 `deploy/raglite-provider`，建议使用 FastAPI/Uvicorn。它只负责把
HTTP 请求转换为 RAGLite 调用，不提供聊天或 Agent 能力。

内部 API 可以保持很小：

```text
GET    /healthz
GET    /v1/collections
POST   /v1/collections
GET    /v1/collections/{collection_id}
PATCH  /v1/collections/{collection_id}
DELETE /v1/collections/{collection_id}
GET    /v1/collections/{collection_id}/documents
POST   /v1/collections/{collection_id}/documents
GET    /v1/documents/{document_id}
DELETE /v1/documents/{document_id}
POST   /v1/documents/{document_id}:index
POST   /v1/documents/{document_id}:stop
GET    /v1/documents/{document_id}/chunks
GET    /v1/documents/{document_id}/content
POST   /v1/search
GET    /v1/jobs/{job_id}
```

这个 API 只在 Docker 内部网络开放，并使用独立 Bearer Token。Provider wire 类型、RAGLite
SQLModel 类型和 DuckDB 内部 ID 都留在 sidecar 内；Go adapter 只看到这套内部 HTTP 契约。

### 2. Provider 自有状态

不能只依赖目录枚举或 RAGLite 的 `document` 表：空 KnowledgeBase 没有 RAGLite 文档，
RAGLite 也没有任务状态、失败原因和幂等键。建议 sidecar 使用一个很小的 SQLite 状态库，
而不是 Aegis Control Plane 数据库：

```text
collections
- id                  # kbs_*，Aegis 生成的稳定公共 ID
- display_name
- folder_uid
- scope_fingerprint
- status
- created_at / updated_at

documents
- id                  # doc_*，Aegis 生成的稳定公共 ID
- collection_id
- original_name
- media_type
- size / sha256
- original_path
- service / tags
- status / failure_reason
- created_at / updated_at / indexed_at

jobs
- id / document_id
- operation            # index, reindex, delete
- status / attempts
- error
- created_at / started_at / finished_at

idempotency_keys
- actor_scope / operation_key / resource_id / content_sha256
```

这不是跨 Provider 的 Aegis 影子数据库，而是 RAGLite Provider 自己的资源和运行状态。它必须
与 DuckDB、原文件目录一起备份和恢复。

### 3. 原文件目录

建议只允许 sidecar 写入以下目录，禁止把浏览器文件名直接当路径：

```text
/data/
  raglite.db
  provider.sqlite
  originals/<collection-id>/<document-id>/<sanitized-original-name>
  tmp/<upload-id>
  model-cache/
```

上传流程为：写入 `tmp`、限制大小并计算 SHA-256、fsync 后原子 rename 到 `originals`，再创建
SQLite document 记录。metadata 中保存相对路径和摘要，不保存用户可控的 `../` 路径。

删除流程反过来执行：先从 RAGLite 删除并确认索引清理，再删除原文件；任一步失败都保留
`delete_pending`，由任务恢复逻辑重试，不能先删文件再猜测向量是否已删除。

### 4. 任务执行与恢复

`insert_documents` 和 `delete_documents` 都是同步调用，并非可取消的任务 API。sidecar 需要：

1. 用 SQLite job 记录把 HTTP 请求快速返回为 `202 Accepted`。
2. 使用单个有界写入 worker；同一个 DuckDB 文件不能由多个进程并发写。
3. `indexing` 任务启动时从原文件重建 `Document.from_path`，传入稳定 document ID 和完整 metadata。
4. 调用 `insert_documents` 成功后查询 Chunk 数量，才把状态置为 `ready`。
5. 进程启动时把遗留的 `running` 任务标记为 `failed/retryable`，通过 document ID 对账；
   RAGLite 自身会跳过已存在的同 ID 文档，因此重试必须先确认是完整索引还是半成品。
6. `stop` 只能阻止尚未开始的任务，或在阶段边界设置取消标记；不能安全中断正在运行的
   PDF 解析、Embedding 或 DuckDB 提交。

不要为这个 MVP 引入 Redis、Celery 或消息队列；单实例、单写 worker 已足够，但必须明确不能
水平扩展多个写入副本。

## KnowledgeProvider 映射

### KnowledgeBase

KnowledgeBase 在 sidecar SQLite 中是真实资源；RAGLite 只通过每个 Document 的 metadata 感知
collection。每个索引文档至少写入：

```python
{
    "aegis_collection_id": "kbs_...",
    "aegis_document_id": "doc_...",
    "aegis_scope": "scp_...",
    "aegis_service": "checkout",
    "aegis_tags": ["prod", "runbook"],
}
```

检索时固定追加 `aegis_scope` 和 collection ID 过滤条件；用户传入的 service 只能作为额外
过滤，不能替代 scope。RAGLite metadata filter 的 AND/OR 语义正好满足这一点。

### Document 与 Chunk

- RAGLite Document ID 直接使用 Aegis `doc_*`，不让 RAGLite 生成的 16 位 hash 进入公共契约。
- RAGLite Chunk ID 是 Provider 内部值；返回 Aegis 前用现有 `knowledgeid.Codec.ChunkID` 派生
  `chk_*`。
- Chunk body、heading 和 index 可直接映射到现有 Chunk 契约。
- RAGLite 的 PDF 转 Markdown 会把页面拼接为 Markdown，当前没有稳定的页码字段；`PageNumber`
  只能为 0，`Position` 可使用 chunk index。若必须提供准确页码，需要另加 PDF 页边界解析，
  这会成为额外能力而非 RAGLite 默认能力。

### 检索与阈值

`hybrid_search` 返回的是 RRF 分数，不是 RAGFlow 那种可直接比较的相似度阈值；`vector_search`
返回 `1 - distance` 的相似度。现有 `RetrievalInput.Threshold` 因此必须在 adapter 中明确
选择一种语义：

- MVP 使用 hybrid search，`threshold=0` 表示不裁剪，非零阈值暂时返回 capability gap；或
- MVP 使用 vector search，保留阈值语义，关键词检索留作后续扩展。

不能把 RRF 分数未经说明地当成 RAGFlow 相似度，否则现有评测和 UI 阈值会产生错误结果。

## 文件格式和模型配置

### 文件格式

- PDF、Markdown、TXT：RAGLite 基础路径可处理。
- DOCX、HTML 等其他格式：需要 `raglite[pandoc]`，也就是 `pypandoc-binary`；要在镜像中
  固定 Pandoc 版本并做格式契约测试。
- Confluence ZIP、图片 OCR、复杂表格：不属于 MVP；Mistral OCR 是外部服务，不能悄悄启用。
- `_markdown.py` 对 `.pdf` 的判断存在大小写敏感路径，sidecar 应在上传时规范扩展名或拒绝
  未支持格式，并覆盖 `MANUAL.PDF` 这类回归测试。

### Embedding 与资源

RAGLite 默认使用 `llama-cpp-python`，但它是可选依赖，不会随着基础 `pip install raglite` 自动
安装。当前测试配置使用多语言 BGE-M3 GGUF：

- `bge-m3-Q4_K_M.gguf`：约 438 MB，适合 CPU 本地 MVP。
- `bge-m3-F16.gguf`：约 1.16 GB，不应作为低资源默认。

建议首版固定：

- Python 3.11。
- `raglite==1.1.1`、`duckdb`、`duckdb-engine`、`llama-cpp-python`、`pypandoc-binary` 的
  完整 lockfile，而不是只写版本范围。
- BGE-M3 Q4 模型的 Hugging Face revision，模型缓存挂载持久卷。
- `reranker=None`，避免默认 FlashRank 多语言模型下载和额外 CPU/RAM；先用 hybrid search 做
  评测。
- `max_workers=1`，写任务串行；查询并发另行压测。

RAGLite 的 SaT 句子切分模型和 DuckDB `fts`/`vss` 扩展也会产生首次启动缓存。DuckDB 初始化
会执行 `INSTALL fts`、`INSTALL vss`，因此生产镜像应预热并固定扩展版本，不能假设离线首次
启动一定成功。

RAGLite 的 `llm` 只在完整 RAG 生成、自查询和上下文窗口计算中使用；Aegis 只需要检索时，
不启动本地 LLM，也不调用 RAGLite 的 `rag()` 或内置 MCP。

## 一致性、升级和备份风险

### 一致性

- DuckDB 只允许单写者；RAGLite 的 insert/delete 使用 file lock，但 sidecar 仍应在进程内
  串行化所有写任务。
- DuckDB 删除文档会分多次提交，官方代码明确说明不是原子操作。删除失败时必须保留任务状态，
  通过 document ID 和 Chunk 数量对账，不能返回确定成功。
- RAGLite Document 正文是 Python private attribute，重启后不能从 DuckDB 重新构造原文；
  原文件目录是重建索引的必要事实来源。

### 升级

- `create_database_engine` 使用 `SQLModel.metadata.create_all`，没有 Aegis 可控制的迁移脚本。
- `index_metadata` 包含 Python pickle；数据库只允许来自受信自己的卷，不能接受外部上传 DB。
- RAGLite 公开 API 足以支撑写入/删除/检索，但列 Chunk、列 Document 需要使用其内部 SQLModel，
  升级时必须跑固定版本 contract test。
- 每次 RAGLite、DuckDB、Embedding 模型或 Pandoc 升级，都需要在副本上完成恢复、重建和 30 条
  检索评测；未验证时保持旧镜像可回退。

### 备份集合

停止 sidecar 写入后，作为一个一致性集合备份：

```text
provider.sqlite
raglite.db
originals/
model-cache/       # 可重建，但要记录模型 revision
duckdb extensions/ # 或在恢复后使用固定镜像重新安装
```

恢复顺序是固定镜像和扩展、两个数据库、原文件目录、模型缓存，然后做健康检查、已知文档
重检索和引用校验，最后才允许写入。

## 需要修改的 Aegis 部分

| 模块 | 工作 |
| --- | --- |
| `internal/adapters/raglite` | HTTP client、错误映射、scope 复核、分页、Chunk/引用映射 |
| `cmd/control-plane` | 显式 `knowledge_provider=raglite` 装配；不直接调用 Python |
| `internal/platform/config` | Provider-neutral URL、token、timeout、embedding/DB 配置 |
| `compose.knowledge.yaml` | RAGLite sidecar、内部网络、两个持久卷、secret、健康检查 |
| `deploy/raglite` | Python `pyproject.toml`/lock、Dockerfile、服务入口和版本说明 |
| `scripts` | 初始化模型/扩展、健康检查、备份恢复和真实检索 smoke |
| `internal/contracts` | Provider API contract、越权、幂等、删除最终一致性测试 |
| `docs/architecture.md` | 接受 ADR 后把 Knowledge 唯一事实来源改为 RAGLite Provider（含 sidecar 状态） |

现有前端公共 OpenAPI 可以保持不变，但以下能力要在首版明确隐藏或返回
`capability_unavailable`：准确 PDF 页码、精确停止正在执行的索引、直接修改已索引 metadata。

## 粗略工作量和分阶段方案

这不是一次简单的 adapter 改名，建议分四阶段：

1. **Contract spike**：用固定模型和单 DuckDB 文件完成上传、插入、混合检索、Chunk 读取、删除、
   重启恢复；验证中文、PDF 和 scope metadata。
2. **Provider service MVP**：加入 SQLite manifest、原文件目录、单写 worker、job 恢复、Bearer
   鉴权和内部 API。预计主要代码是 Python service、测试和 Docker/lockfile，而不是 RAG 算法。
3. **Go adapter cutover**：实现 `ports.KnowledgeProvider`，复用现有公共 API、MCP 和 Folder
   授权，不改变前端契约；RAGFlow 仍保留显式回退。
4. **真实验收**：30 份以上中文运维文档、越权测试、删除/恢复、资源峰值、冷启动和检索评测。

若只做基本能力，主要新增量约为一个中等规模 Python 服务、一个 Go adapter 和部署/契约测试；
不会达到 RAGFlow 当前 1773 行 adapter + 六容器运维复杂度，但也不能压缩成一个几十行的 HTTP
转发器。真正需要认真处理的是任务恢复、DuckDB 单写、一致性和版本锁定。

## 最终建议

对本项目的目标排序如下：

1. **长期边界和本机资源优先**：选择 RAGLite，接受增加 Python sidecar，并把 Chunk 页码、精确
   取消和 metadata 原地更新降为后续能力。
2. **最快完成可用闭环优先**：选择 AnythingLLM，少写 Provider service，但接受更宽的平台边界。

基于用户明确表示可以自己补 REST 和目录存储，RAGLite 现在应作为首选候选；在接受 ADR 前，先
完成上面的 Contract spike，尤其验证 DuckDB 扩展离线启动、BGE-M3 Q4 CPU 索引速度和删除恢复。

## 参考资料

- [RAGLite v1.1.1](https://github.com/superlinear-ai/raglite/tree/v1.1.1)
- [RAGLite README](https://github.com/superlinear-ai/raglite/blob/v1.1.1/README.md)
- [RAGLite database models](https://github.com/superlinear-ai/raglite/blob/v1.1.1/src/raglite/_database.py)
- [RAGLite indexing](https://github.com/superlinear-ai/raglite/blob/v1.1.1/src/raglite/_insert.py)
- [RAGLite search](https://github.com/superlinear-ai/raglite/blob/v1.1.1/src/raglite/_search.py)
- [RAGLite license](https://github.com/superlinear-ai/raglite/blob/v1.1.1/LICENSE)
