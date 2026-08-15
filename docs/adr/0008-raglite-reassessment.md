# ADR 0008：RAGLite 作为轻量 Knowledge Provider

- 状态：接受，实施中
- 日期：2026-08-15
- 关联：取代 ADR 0007（AnythingLLM 提议）

## 背景

用户确认可以接受自行编写内部 REST API，并把原文件保存在 Provider 目录。这个前提改变了
AnythingLLM 与 RAGLite 的比较：RAGLite 虽然不是现成服务，但已经包含 Aegis 最不应该自研的
文档解析、语义切分、Embedding、DuckDB FTS/VSS、混合检索和 metadata 过滤。

## 决策

1. 以 RAGLite `1.1.1`（commit `6a540e1bd10f80093316deb44e049c1308e9f7e7`）作为首选轻量实现，增加一个 Python Provider sidecar；AnythingLLM
   保留为“少写服务代码”的备选，不进入当前实现。
2. sidecar 使用 RAGLite DuckDB 保存 Document、Chunk、Embedding 和索引；使用 Provider 自有
   SQLite 保存 KnowledgeBase、Document 生命周期、幂等键和 job 状态；原始文件保存于受控目录。
3. sidecar 只提供内部 Bearer 鉴权 REST，不暴露 RAGLite 内置 MCP、RAG 生成或任何 Agent 能力。
4. 通过 RAGLite metadata 写入 `aegis_collection_id`、`aegis_document_id` 和 scope fingerprint；
   每次检索强制追加 scope + collection filter。Provider/数据库内部 ID 不进入 Aegis 公共契约。
5. 首版基本能力为 collection/document CRUD、上传解析、异步索引、删除、原文件下载、Chunk
   浏览和混合检索。准确 PDF 页码、硬取消正在执行的索引、索引后 metadata 原地修改暂列能力缺口。
6. DuckDB 写入固定单 worker，服务只支持单实例；RAGLite、DuckDB、Python、Pandoc、Embedding
   模型和 DuckDB 扩展全部固定版本并通过恢复/契约测试后才能接受。

## 实施验收门槛

- 固定 RAGLite 版本可在无外网的稳态镜像中加载 FTS/VSS 扩展和 BGE-M3 Q4 模型。
- PDF、Markdown、TXT 真实闭环通过；DOCX/HTML 只有在 Pandoc 固定后才启用。
- DuckDB 单写下的并发上传、删除、检索、进程重启和半成品索引恢复通过。
- Folder 越权检索 100% 拒绝；scope metadata 缺失或不匹配 fail-closed。
- 删除、原文件、两个数据库和模型版本的备份恢复演练通过。
- 至少 30 条中文运维检索评测，并记录 RSS、CPU、索引耗时和磁盘增量。

## 影响

- 比 RAGFlow 少掉 Elasticsearch、MySQL、MinIO、Valkey、TEI 等常驻依赖；运行形态是一个
  Python sidecar + DuckDB/SQLite/目录。
- Aegis 新增任务恢复和 Provider 状态代码，但不新增自研 RAG 算法或向量数据库。
- RAGLite 为 MPL-2.0；发布时必须保留许可证和通知，不能把其源码静默并入 Apache-2.0 代码。
- ADR 0007 的 AnythingLLM 方案被本 ADR 取代，RAGFlow 继续保留显式回退窗口。

详细工作拆分见
[RAGLite 接入详细调研](../research/raglite-integration-research.md)。
