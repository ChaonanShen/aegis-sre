# ADR 0007：以 AnythingLLM 替换本地 RAGFlow Knowledge Provider

- 状态：已被 ADR 0008 取代
- 日期：2026-08-15

## 背景

当前 Knowledge 可选部署使用 RAGFlow 0.26.4，并同时运行 Elasticsearch、MySQL、MinIO、Valkey
和 TEI。仓库部署说明要求至少 12 GiB RAM 和 50 GiB 磁盘，已超过目标开发机可稳定提供的资源，
导致阶段 8 虽然已有 adapter 和 UI，却无法在本机完成真实 Provider 验收。

只改用 Chroma 或 Qdrant 会把文档解析、切分、原文件、Embedding 任务和引用映射重新推回 Aegis，
违反产品控制面只做必要适配的边界。RAGLite 虽然更小，但没有可直接适配的管理 REST API，同样需要
Aegis 新建并维护一个知识服务。

## 历史提议

1. Knowledge Provider 从 RAGFlow 切换为固定版本 AnythingLLM v1.16.0。本地采用单容器、SQLite、
   LanceDB 和内置 Embedding；发布使用 `mintplexlabs/anythingllm:1.16.0` 并固定多架构 digest。
2. Aegis 只接入 AnythingLLM 的 Workspace、Document、Embedding 更新和 Vector Search API，
   不使用其聊天、Agent、工作流、多用户界面或 LLM 生成能力。
3. `KnowledgeBase` 映射为 Workspace，Document 映射为解析后的 Document，检索映射为 Workspace
   Vector Search。公共 ID、scope fingerprint、Folder 授权与 Knowledge MCP 契约保持 Provider-neutral。
4. 首版基本能力限定为知识库 CRUD、文档上传/解析/删除、索引和带文档引用的向量检索。缺少稳定
   上游 API 的原文件下载、全量 Chunk 浏览、文档 metadata 原地更新和精确索引取消返回
   `capability_unavailable`，不在 Control Plane 中模拟。
5. 配置项改为 Provider-neutral 名称，并增加显式 `AEGIS_KNOWLEDGE_PROVIDER=anythingllm|ragflow`。
   未配置、凭据缺失或 Provider 不可达时 fail-closed，不能回退 fixture/mock。
6. RAGFlow 实现至少保留一个到两个发布周期，只能作为显式选择的回退 Provider；删除前遵循作者
   确认、兼容窗口和回退记录要求。

## 原接受条件

本 ADR 在以下验证完成后从“提议”改为“接受”：

- 固定 v1.16.0 的真实 API contract spike 证明公共 ID、scope metadata、文档引用可跨重启恢复。
- Markdown、TXT、PDF、DOCX、HTML 的真实上传、解析、删除和向量检索闭环通过。
- Folder 越权访问 100% 被拒绝，Provider 内部 ID 不进入公共响应。
- 本机实测资源显著低于当前 RAGFlow 栈，并记录冷启动、空载、索引峰值和磁盘增量。
- 不支持的公共能力已由稳定错误和前端禁用状态明确表达。

## 影响

- 本地 Knowledge 从六个常驻容器降为一个，开发机可以运行真实检索闭环。
- RAGFlow 更强的混合检索、页码位置、Chunk 管理和异步解析控制不再是首版承诺。
- AnythingLLM 的额外产品能力不会进入 Aegis 架构或前端公共契约。
- Control Plane 继续无状态，AnythingLLM 持有 Workspace、Document、Embedding 和索引数据。

详细候选对比与 API 映射见
[轻量 Knowledge Provider 替换调研](../research/lightweight-rag-replacement-research.md)。
