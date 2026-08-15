# 轻量 Knowledge Provider 替换调研

> 调研日期：2026-08-15  
> 目标：在本机可运行的前提下，以成熟开源组件替换当前 RAGFlow Knowledge Provider；Aegis
> 继续只维护控制面、授权收敛和必要 adapter，不实现文档解析、切分、Embedding 或向量检索。

## 复核结论

本报告最初按“不新增 Provider 服务”这个前提推荐 AnythingLLM。用户确认可以自行补充内部
REST API 和原文件目录后，结论需要修正：**RAGLite 更符合 Aegis 的长期边界；AnythingLLM
只是更快接通的备选**。RAGLite 的新增工作集中在资源管理、任务恢复和协议适配，不是重新实现
解析、切分或向量检索。详细拆分见 [RAGLite 接入调研](raglite-integration-research.md)。

## 原结论（AnythingLLM 备选）

建议首选 **AnythingLLM v1.16.0**，使用其 Docker Server、内置 SQLite 元数据存储、LanceDB
向量库和本地 Embedding。Aegis 只调用 API 中的 Workspace、Document、Embedding 更新和
Vector Search，不使用 AnythingLLM 的聊天、Agent、工作流或自带多用户产品界面。

这个选择不是因为 AnythingLLM 的功能边界最小，而是因为它是候选中唯一同时满足以下条件、
又不要求 Aegis 补写 RAG 基础设施的方案：

- 单容器运行，官方最低建议 2 GiB RAM、10 GiB 磁盘，支持 `amd64` 和 `arm64`。
- 默认使用内置 SQLite、LanceDB 和本地 Embedding，不要求 Elasticsearch、MySQL、MinIO、
  Valkey 和独立 TEI。
- 提供 API Key 保护的 Workspace CRUD、文档上传与解析、文档列表、Embedding 更新和原始
  Vector Search API。
- 支持 PDF、DOCX、Markdown、TXT、HTML 等当前 UI 已声明的基本文件类型。
- MIT 许可证，项目活跃，v1.16.0 发布于 2026-08-13；对应 Git commit 为
  `55b6ebcea132f0d7ac146da99a0cd0db507b9030`。

已验证的多架构镜像为
`mintplexlabs/anythingllm:1.16.0@sha256:68bcedecb720e3fadde986bcc4f3aad20059fa64805bc9b306a3023244947515`；
其中 amd64 manifest 为 `sha256:983528ccf4e41145d757354a6de2325e7bc91e35ae438d4173a6e82a1f3145f6`，
arm64 manifest 为 `sha256:2da9c08560d7448ae8dad021ae97fcc3707b2149c771b7f1b5b075fc0d2d3d4c`。
发布部署使用 `1.16.0` 标签和多架构 digest，不使用不存在的 `v1.16.0` 镜像标签或 `latest`。

与当前本地 RAGFlow 栈相比，稳态依赖由 RAGFlow、Elasticsearch、MySQL、MinIO、Valkey、TEI
六个常驻容器缩减为一个 AnythingLLM 容器。RAGFlow 当前文档要求至少 12 GiB RAM 和 50 GiB
磁盘，且 TEI 镜像展开后约 33 GB；替换能直接解决本机无法启动的问题。

## 方案对比

| 方案 | 本地形态 | 文档生命周期 API | 检索 | 与 Aegis 的主要问题 | 结论 |
| --- | --- | --- | --- | --- | --- |
| AnythingLLM 1.16.0 | 单容器，SQLite + LanceDB | Workspace、上传、解析、文档列表、增删 Embedding | 原始向量检索 API | 带有不用的聊天/Agent；部分管理能力弱于 RAGFlow | 推荐 |
| RAGLite 1.1.1 | Python 库，DuckDB 单文件 | 需自建薄 REST service | 向量、关键词和混合检索 | 需要任务/资源层，但 RAG 核心边界最干净 | 条件首选 |
| LightRAG 1.5.6 | 单容器，默认本地文件存储 | 有上传、删除和查询 API | 图谱增强检索 | 索引阶段依赖 LLM 做实体关系抽取；多知识库管理不贴合现有契约 | 不推荐基础模式使用 |
| Chroma 1.5.9 | 单服务或嵌入式 | Collection 和向量 CRUD | 向量/全文检索 | 不是完整 RAG；解析、切分、原文件和任务状态要由 Aegis 实现 | 不推荐直接替换 |
| Qdrant | 单服务 | Collection 和向量 CRUD | 向量/混合检索 | 与 Chroma 相同，只替换了索引层 | 不推荐直接替换 |
| RAGFlow 0.26.4 | 六容器本地栈 | 最完整 | 混合检索、引用、重排 | 资源占用超过当前本机能力 | 保留短期回退，不再作为本地默认 |

## 与现有 Knowledge 契约的映射

| Aegis 能力 | AnythingLLM API/语义 | 首版处理 |
| --- | --- | --- |
| KnowledgeBase CRUD | Workspace CRUD | 支持；Workspace 名称使用确定性 Aegis namespace |
| 文档上传与解析 | `POST /v1/document/upload` | 支持；上传时写入 Aegis metadata，并加入目标 Workspace |
| 开始索引 | Workspace `update-embeddings` add | 支持为幂等操作 |
| 停止索引 | Workspace `update-embeddings` remove | 仅能移除已有向量，不能取消正在执行的解析 |
| 文档列表 | Workspace detail 中的 documents | 支持 |
| 检索 | `POST /v1/workspace/{slug}/vector-search` | 支持；多个知识库分别检索后在 adapter 内按 score 合并 |
| 引用 | Vector Search result metadata | 支持文档级引用；页码精度需契约测试确认 |
| Chunk 浏览 | 没有按文档分页列出全部向量的稳定公开 API | 首版标记 `capability_unavailable` |
| 原文件下载 | 公开 API 主要返回解析后的 document JSON | 首版标记 `capability_unavailable`，不能伪装成原文件 |
| 更新 Service/Tags | 上传 metadata 字段有限，缺少通用更新 API | 首版标记 `capability_unavailable` 或通过删除重传完成 |
| 异步状态/取消 | 上传和 Embedding 更新没有等价的 RAGFlow 任务模型 | 状态收敛为 pending/ready/failed；不承诺精确取消 |

AnythingLLM 的 Workspace slug、内部文档名、SQLite ID 和 LanceDB namespace 仍是 Provider 类型，
不得进入公共 API、领域模型、日志或 MCP 输出。Aegis 公共 ID 和可信 Folder 授权规则保持不变；
adapter 必须在每次操作时验证保存于 Provider 原生字段中的 scope fingerprint，不能把公共 ID 当成
授权凭据。

## RAGLite 的真实工程代价

RAGLite 的 DuckDB、PDF 转 Markdown、切分和混合检索很适合单机实验。它是 Python toolkit，
不是带稳定管理 API 的独立 Provider；因此需要增加一个 Python sidecar、Provider 自有 SQLite
manifest、原文件目录、单写 worker、任务恢复和升级/备份协议。这些工作属于 Provider 资源层，
不会重新实现 RAG 通用算法，但仍然是一个中等规模的工程，不是简单 HTTP 转发。

如果只保留一个只读语料库，RAGLite 可以进一步缩小；当前完整 Knowledge 契约则必须接受任务
状态、原文件目录和 DuckDB 单写约束。具体 API、数据模型和恢复流程见独立详细调研。

## 为什么不直接使用 Chroma 或 Qdrant

两者都是轻量而成熟的向量数据库，但并不负责完整 RAG 文档摄取。采用它们后，Aegis 仍要选择和
维护解析器、切分器、Embedding worker、原文件存储、索引任务与引用映射。这正是架构规范要求交给
Provider 的能力，因此容器更少并不代表系统更简单。

## 实施边界

1. 新增 `internal/adapters/anythingllm`，实现现有 `ports.KnowledgeProvider`；Provider wire 类型
   只留在 adapter 内。
2. 配置改为 Provider-neutral 的 `AEGIS_KNOWLEDGE_URL`、`AEGIS_KNOWLEDGE_API_KEY_FILE` 和
   `AEGIS_KNOWLEDGE_TIMEOUT`。兼容窗口内继续读取旧 RAGFlow 配置，但必须显式选择 Provider，
   不允许真实模式静默回退。
3. `compose.knowledge.yaml` 切到固定 AnythingLLM 1.16.0 镜像和 digest，仅挂载一个持久卷及
   API Key secret；不发布稳态主机端口。
4. RAGFlow adapter 和部署文件至少保留一个到两个发布周期作为显式回退路径，未与作者确认前不删。
5. 不接入 AnythingLLM 原生 UI、聊天、Agent 或 LLM 生成接口；Agent 仍只经 Aegis Knowledge MCP
   使用检索结果。
6. AnythingLLM 不具备的能力返回稳定的 `capability_unavailable`，不使用 fixture、内存状态或
   Aegis 数据库模拟成功。

## 实施前验证门

- 用固定 v1.16.0 实例验证 Workspace 名称、文档 metadata 和 scope fingerprint 可跨重启恢复。
- 验证 PDF、DOCX、Markdown、TXT、HTML 上传及中文运维文档的解析结果。
- 验证本地 Embedder 的模型、向量维度和升级行为可固定，并记录首次下载所需磁盘。
- 验证 Vector Search score 方向、阈值和 metadata 引用，避免错误归一化相关性。
- 验证删除 Workspace、删除文档和移除 Embedding 后的索引最终一致性。
- 运行现有 Knowledge port contract、Folder 越权测试和至少 30 条标注检索评测。
- 实测空载、单文档索引和检索时的 RSS、CPU、磁盘增量与冷启动时间；2 GiB 是官方最低建议，
  不是 Aegis 的验收结果。

## 参考资料

- [AnythingLLM v1.16.0](https://github.com/Mintplex-Labs/anything-llm/releases/tag/v1.16.0)
- [AnythingLLM Docker 部署](https://github.com/Mintplex-Labs/anything-llm/blob/v1.16.0/docker/HOW_TO_USE_DOCKER.md)
- [AnythingLLM Workspace API](https://github.com/Mintplex-Labs/anything-llm/blob/v1.16.0/server/endpoints/api/workspace/index.js)
- [AnythingLLM Document API](https://github.com/Mintplex-Labs/anything-llm/blob/v1.16.0/server/endpoints/api/document/index.js)
- [RAGLite v1.1.1](https://github.com/superlinear-ai/raglite/releases/tag/v1.1.1)
- [LightRAG v1.5.6](https://github.com/HKUDS/LightRAG/releases/tag/v1.5.6)
- [Chroma 1.5.9](https://github.com/chroma-core/chroma/releases/tag/1.5.9)
