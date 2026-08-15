# Knowledge Provider 抽象与 RAGLite 迁移执行计划

> 状态：执行前方案，待 contract spike 通过后进入实现
>
> 日期：2026-08-15
>
> 关联：docs/adr/0004-knowledge-identity-and-folder-authorization.md、
> docs/adr/0006-provider-capability-gaps.md、docs/adr/0008-raglite-reassessment.md

基础调研见 [RAGLite 接入详细调研](research/raglite-integration-research.md) 和
[轻量 RAG 替代方案调研](research/lightweight-rag-replacement-research.md)。

## 1. 决策摘要

Aegis 不直接把 RAGLite 的 Python API 暴露给 Control Plane，也不把 RAGFlow 的协议固化到产品层。
继续使用现有 ports.KnowledgeProvider 作为唯一公共边界，新增 RAGLite adapter 和 Python
Provider sidecar，并通过显式配置选择一个 Knowledge Provider。

首个迁移周期支持：

~~~text
AEGIS_KNOWLEDGE_PROVIDER=ragflow|raglite
~~~

同一个 Control Plane 实例只装配一个 Provider。迁移通过新的部署配置和数据重建完成，不按
Collection 或 Document 动态路由。RAGFlow 在 RAGLite 通过验收后仍保留 1～2 个发布周期的只读或
显式回退能力，再按根目录 AGENTS.md 的要求删除旧实现。

这份文档是实施细节的唯一入口；[详细实施计划](implementation-plan.md) 只保留阶段索引和依赖关系。

## 2. 范围与非目标

### 2.1 范围

- 把 Knowledge Provider 的装配从 cmd/control-plane/main.go 中抽出为 factory/registry。
- 新增 internal/adapters/raglite，实现现有 ports.KnowledgeProvider。
- 新增一个单实例 Python sidecar，封装 RAGLite 1.1.1。
- 保持公共 REST、MCP、领域模型和前端契约不变。
- 迁移原文件、业务 metadata、公共 Collection/Document ID 和检索评测数据。
- 建立 Provider contract tests、恢复测试、权限测试和 RAGLite 质量门禁。

### 2.2 非目标

- 不在 Aegis 中重新实现解析器、切分器、Embedding、向量数据库或 RAG 生成。
- 不把 RAGLite 内置 MCP、聊天、Agent 或 Workspace 能力接入产品。
- 不引入 Redis、Celery、消息队列或多副本 DuckDB 写入集群。
- 不为弥补 Provider 差异建立 Control Plane 影子数据库。
- 不在本阶段支持图片 OCR、Confluence ZIP、复杂表格解析或精确 PDF 页码。

## 3. 当前基线与问题

当前公共边界已经存在：

- KnowledgeProvider 已经是 Provider-neutral 的 Collection、Document、Chunk、下载和检索接口。
- HTTP API 和 Knowledge MCP 只依赖该接口，不直接依赖 RAGFlow SDK。
- RAGFlow adapter 位于 internal/adapters/ragflow/，已有客户端、错误映射和测试。
- Control Plane 装配仍直接创建 RAGFlow client/provider。
- 配置仍以 AEGIS_RAGFLOW_* 为中心，不能切换到本地 sidecar。

因此当前缺口是“Provider 装配和第二个实现”，不是重新发明一层领域抽象。接口是否需要增加
RAGLite 特有能力，必须先经过能力差异评审；默认不扩张 ports.KnowledgeProvider。

## 4. 目标架构

~~~mermaid
flowchart LR
    Plugin[Grafana Plugin] --> CP[Aegis Control Plane]
    CP --> Port[ports.KnowledgeProvider]
    Port --> Factory[Knowledge Provider Factory]
    Factory --> RF[Go RAGFlow Adapter]
    Factory --> RL[Go RAGLite Adapter]
    RF --> RAGFlow[RAGFlow REST]
    RL --> Sidecar[Python RAGLite Provider]
    Sidecar --> State[provider.sqlite]
    Sidecar --> DuckDB[raglite.db / DuckDB]
    Sidecar --> Originals[originals/]
~~~

Control Plane 仍然无状态。RAGLite sidecar 的 SQLite、DuckDB 和原文件目录属于 RAGLite Provider，
不是 Aegis 的跨 Provider 业务数据库。Provider 内部的 SQLModel、DuckDB chunk ID 和 RAGLite 类型
不能越过 Go adapter。

## 5. Provider 抽象设计

### 5.1 公共接口

继续使用现有接口和现有稳定错误码：

- 未配置 Provider：capability_unavailable
- Provider 不可达：provider_unavailable
- 不确定的写入结果：provider_result_unknown
- Provider 不支持的能力：capability_unavailable

不能为了让两个实现“接口完整”而在 Control Plane 内存中伪造索引状态、取消语义或幂等保证。

### 5.2 Factory

建议新增一个只负责装配的内部组件：

~~~go
func NewKnowledgeProvider(
    cfg config.Config,
    ids ports.KnowledgeIDGenerator,
) (ports.KnowledgeProvider, error)
~~~

Factory 负责：

1. 校验 Provider 名称和对应配置。
2. 创建带超时、认证和响应上限的 client。
3. 创建 ragflow 或 raglite adapter。
4. 返回统一的 ports.KnowledgeProvider。

Factory 不负责业务授权、资源映射或任务重试；这些分别属于 Control Plane/application 和对应
Provider。

### 5.3 单实例选择

首版只支持部署级选择：

~~~text
一个 Control Plane 实例 -> 一个 Knowledge Provider
~~~

不支持同一实例内按资源混用。这样公共 ID、Folder 授权、备份恢复和 MCP 检索都可以保持无状态，
也不需要维护 document_id -> provider 映射表。

### 5.4 能力差异

暂不增加 Capabilities() 接口，优先让操作返回稳定的 capability_unavailable。只有前端需要
在页面上主动隐藏某项操作时，才新增 Provider-neutral 能力描述，例如 PagePositions 或
IndexCancellation，不能暴露 RAGLite/RAGFlow 名称。

RAGLite 首版的已知差异：

| 公共能力 | RAGLite 首版语义 | 处理方式 |
| --- | --- | --- |
| StartIndexing | 异步 job，sidecar 串行写入 | 支持 |
| StopIndexing | 只能可靠停止尚未开始的 job | 运行中返回能力缺口或阶段性取消 |
| RetrievalInput.Threshold | hybrid search 是 RRF 分数 | 明确阈值策略；未定义前拒绝非零阈值 |
| KnowledgeChunk.PageNumber | PDF 默认没有可靠页码 | 首版返回 0，位置使用 chunk index |
| 索引后 metadata 修改 | 可能需要重建 Document | 转换为 reindex 或返回能力缺口 |

## 6. RAGLite sidecar 设计

### 6.1 进程与依赖

- Python 3.11。
- raglite==1.1.1，固定 commit/tag、依赖 lockfile 和镜像 digest。
- DuckDB、duckdb-engine、llama-cpp-python 固定版本。
- 默认 BGE-M3 Q4 GGUF；reranker=None，max_workers=1。
- 预热 fts、vss 扩展和 SaT 模型缓存，生产镜像不能依赖首次启动联网。
- RAGLite 的 MPL-2.0 license/notice 随发布物保留。

### 6.2 内部 REST

只在容器网络暴露内部 Bearer-auth REST，不将其直接暴露给 Grafana：

~~~text
GET    /healthz
GET    /v1/collections
POST   /v1/collections
GET    /v1/collections/{collection_id}
PATCH  /v1/collections/{collection_id}
DELETE /v1/collections/{collection_id}
GET    /v1/collections/{collection_id}/documents
POST   /v1/collections/{collection_id}/documents
GET    /v1/documents/{document_id}
PATCH  /v1/documents/{document_id}
DELETE /v1/documents/{document_id}
POST   /v1/documents/{document_id}:index
POST   /v1/documents/{document_id}:stop
GET    /v1/documents/{document_id}/chunks
GET    /v1/documents/{document_id}/content
POST   /v1/search
GET    /v1/jobs/{job_id}
~~~

所有响应都使用 Provider-neutral 字段；RAGLite SQLModel 和 DuckDB 内部 ID 不出现在 wire contract。

### 6.3 Provider 状态

sidecar 使用小型 SQLite 保存 RAGLite 不提供的资源生命周期：

~~~text
collections: id, name, folder_uid, scope_fingerprint, status, timestamps
documents: id, collection_id, name, media_type, size, sha256, original_path,
           service, tags, status, failure_reason, timestamps
jobs: id, document_id, operation, status, attempts, error, timestamps
~~~

这是 Provider 自有状态，不是 Control Plane 的通用映射表。它必须和 DuckDB、原文件、模型版本
一起备份恢复。当前不另建 `idempotency_keys` 表：Control Plane 派生的稳定资源 ID、SQLite 唯一
约束和原文件 SHA-256 共同处理重复请求；出现不确定写入时由调用方按稳定 ID 查询对账。

### 6.4 原文件安全存储

~~~text
/data/
  provider.sqlite
  raglite.db
  originals/<collection-id>/<document-id>/<safe-name>
  tmp/<upload-id>
  model-cache/
~~~

上传流程：限制大小并清洗文件名 -> 写入 tmp -> 计算 SHA-256 -> fsync -> 原子 rename -> 写入
Document manifest -> 创建索引 job。用户文件名只能作为清洗后的显示名，不能直接参与路径拼接。

首版删除是同步操作：先拒绝存在活动索引 job 的文档，再删除 RAGLite
Document/Chunk/Embedding，随后删除原文件和 SQLite manifest。RAGLite 删除失败时保留原文件与
manifest 供重试；RAGLite DuckDB 删除本身不是原子事务，半成品删除和后续步骤失败仍需在 P3
通过故障注入与对账恢复验证。

### 6.5 Metadata 与授权

每个索引 Document 至少写入：

~~~python
{
    "aegis_collection_id": "kbs_...",
    "aegis_document_id": "doc_...",
    "aegis_scope": "scp_...",
    "aegis_service": "checkout",
    "aegis_tags": ["prod", "runbook"],
}
~~~

检索始终强制追加 aegis_scope 和 Collection 过滤。Service、Tag 是额外过滤条件，不能替代
Actor/Folder scope。scope 缺失或不匹配时必须 fail-closed。

## 7. 关键生命周期

### 7.1 上传与索引

1. Go adapter 生成稳定的 Collection/Document ID，并把 Actor scope 传给 sidecar。
2. sidecar 安全保存原文件和摘要，写入 Document manifest，上传 API 返回 201。
3. 调用独立的 index endpoint 创建 job 并返回 202；请求不等待 Embedding 完成。
4. 单写 worker 从原文件重建 Document.from_path，带入稳定 ID 和完整 metadata。
5. insert_documents 成功后检查 Chunk 数量，再把 Document 标为 ready。

### 7.2 重启恢复

启动时：

1. 检查 SQLite 中遗留的 running job。
2. 将其标记为可重试失败或重新排队。
3. 对账 RAGLite 中是否存在完整 Document/Chunk。
4. 半成品先清理再重建，不能只依据“Document ID 已存在”判断成功。

### 7.3 检索

1. Control Plane 校验 Actor、Folder 和 Service 范围。
2. Go adapter 调 sidecar /v1/search。
3. sidecar 强制合并 scope/collection metadata filter。
4. adapter 把内部 Chunk ID 派生为 chk_*，映射 SourceName、Position、PageNumber 和 Score。
5. 不把 RRF score 未经定义地当作 RAGFlow 相似度。

## 8. 配置变更

目标配置：

~~~text
AEGIS_KNOWLEDGE_ENABLED=false
AEGIS_KNOWLEDGE_PROVIDER=raglite|ragflow
AEGIS_KNOWLEDGE_URL=http://raglite-provider:8090
AEGIS_KNOWLEDGE_TOKEN_FILE=/run/secrets/knowledge-token
AEGIS_KNOWLEDGE_ID_KEY_FILE=...
AEGIS_KNOWLEDGE_EMBEDDING_MODEL=...
AEGIS_KNOWLEDGE_TIMEOUT=30s
~~~

兼容窗口内保留旧 AEGIS_RAGFLOW_* 变量的读取和迁移说明，但新代码不再增加新的 RAGFlow-specific
公共配置。配置规则：

- Provider 未配置时不装配、不注册 Knowledge MCP，返回 capability_unavailable。
- ragflow 需要 URL、API key 和现有 RAGFlow 参数。
- raglite 需要 sidecar URL、Bearer token、ID key，数据目录由 sidecar 管理。
- 一个 Provider 配置不允许混入另一个 Provider 的凭据，避免误连和错误启动。

## 9. 执行阶段与退出标准

当前进度（2026-08-15）：P0 的架构决策和能力语义、P1 的 sidecar 骨架、P2 的 Go adapter 与
factory、RAGLite 容器和本地叠加部署已经落地。单元与边界测试、镜像构建和运行时导入冒烟通过；
真实 PDF/TXT、DuckDB 扩展离线预热、双 Provider 公共 contract suite、故障注入、备份恢复和
30 条中文运维问题质量门禁仍未完成，因此尚不能进入生产切换。

### P0：文档与契约冻结

- [x] 接受或修订 ADR 0008，确认 Provider factory、单实例选择和回退窗口。
- [x] 更新 docs/architecture.md 中仍指向 RAGFlow 唯一事实来源的表述。
- [x] 为 KnowledgeProvider 每个方法写出 RAGLite 语义和能力缺口。
- [ ] 固定内部 REST JSON schema、错误码和 job 状态机。

退出标准：没有未决的公共 ID、授权、阈值和任务取消语义。

### P1：RAGLite contract spike

- [x] 建立最小 Python sidecar、Dockerfile、lockfile 和 /healthz。
- [ ] 完成 PDF/Markdown/TXT 上传、索引、检索、Chunk、原文下载闭环。
- [ ] 验证 DuckDB 扩展离线预热、BGE-M3 Q4 加载和单写 worker。
- [x] 建立 sidecar 单元测试。
- [ ] 建立真实 PDF/Markdown/TXT 文件集冒烟测试。

退出标准：在无 RAGFlow、无外网运行时能稳定完成 10 份小文档的索引和检索。

### P2：Go adapter 与 factory

- [x] 新增 internal/adapters/raglite。
- [x] 把 RAGFlow/RAGLite 装配移入 factory，清理 main.go 中的 Provider-specific 分支。
- [x] 统一超时、认证、响应限制和错误映射。
- [ ] 为 RAGFlow 和 RAGLite 运行同一套 KnowledgeProvider contract tests。
- [x] 为非零阈值、运行中 stop、无页码 PDF 增加能力缺口测试。

退出标准：Control Plane 仅依赖 ports.KnowledgeProvider，两种实现都能通过公共契约测试。

### P3：真实恢复与安全门禁

- [ ] 测试并发上传、删除、检索和单写队列。
- [ ] 注入进程重启、半成品索引、磁盘满、sidecar 超时和不确定写入结果。
- [x] 验证 scope 缺失、跨 Folder、伪造 Collection ID 的 fail-closed 行为。
- [ ] 演练 provider.sqlite、raglite.db、originals 和 model-cache 的备份恢复。

退出标准：越权检索 100% 拒绝，恢复演练成功，所有不确定写入均可对账。

### P4：数据迁移与双部署验收

- [ ] 从 RAGFlow 导出原始文件和 Collection/Document metadata。
- [ ] 保留原公共 ID，导入 RAGLite 并重新索引；禁止直接复制 RAGFlow 私有索引。
- [ ] 使用至少 30 条中文运维问题进行 Top-K、删除残留和引用质量对比。
- [ ] 记录 CPU、RSS、索引耗时、磁盘增量和启动耗时。
- [x] 准备 RAGFlow 显式回退配置。
- [ ] 在迁移演练中验证 RAGFlow 只读运行模式。

退出标准：RAGLite 通过质量和资源门禁，且可以在不改前端契约的情况下切换部署。

### P5：生产切换与观察

- [ ] 将生产/预生产配置切换为 AEGIS_KNOWLEDGE_PROVIDER=raglite。
- [ ] 观察至少一个完整发布周期的失败率、恢复、检索和磁盘增长。
- [ ] 保持 RAGFlow 只读或显式回退能力 1～2 个发布周期。
- [ ] 更新运行手册、备份手册、许可证通知和版本清单。

退出标准：没有未解释的索引丢失、越权、恢复失败或明显质量回归。

### P6：删除 RAGFlow

只有同时满足以下条件才允许物理删除：

- RAGLite 已完成至少 1～2 个发布周期的真实运行。
- 回退窗口已关闭并记录最终版本和原因。
- RAGFlow 数据已完成归档或明确不再需要迁移。
- 原作者已确认；无法联系时在迁移记录中写明原因、兼容窗口和回退方式。
- 删除 internal/adapters/ragflow/、deploy/ragflow/、旧配置和测试后，所有 Go/前端/契约检查通过。

## 10. 测试与验收矩阵

| 层级 | 必须覆盖 |
| --- | --- |
| Go adapter | HTTP schema、分页、错误映射、超时、响应上限、ID 映射 |
| Provider contract | CRUD、上传、索引状态、删除、Chunk、下载、检索、越权 |
| Sidecar | 路径安全、SHA-256、原子 rename、job 状态、DuckDB 单写、重启恢复 |
| 数据 | PDF/Markdown/TXT；DOCX/HTML 仅在 Pandoc 固定后启用 |
| 安全 | scope 缺失、Folder 越权、伪造 ID、Bearer 错误、敏感错误净化 |
| 性能 | 30～50 份文档、查询延迟、RSS、CPU、索引耗时、磁盘增量 |
| E2E | Plugin -> Control Plane -> Knowledge Provider -> 检索引用和原文下载 |

质量基线建议：解析成功率不低于 95%，人工标注片段 Top 5 命中率不低于 85%，越权请求 100%
拒绝，删除后在约定窗口内不再返回 Chunk。

## 11. 风险与应对

| 风险 | 应对 |
| --- | --- |
| DuckDB 单写限制 | 单实例、单写 worker；禁止水平扩展写副本 |
| RAGLite 无任务持久化 | Provider SQLite job manifest、启动恢复和对账 |
| hybrid 分数不能对应旧阈值 | 首版定义阈值策略；未定义时拒绝非零阈值 |
| PDF 页码缺失 | 首版 PageNumber=0，Position 用 chunk index；精确页码另立能力项 |
| 原文件与索引不一致 | 原子上传、delete_pending、备份恢复演练 |
| RAGLite 版本/扩展变化 | lockfile、镜像 digest、离线预热和升级 contract tests |
| 迁移后检索质量下降 | 固定评测集、RAGFlow 对比报告和可回退窗口 |
| Provider 名称泄漏 | 公共层只使用 ports 和稳定错误码，wire 类型隔离在 adapter/sidecar |

## 12. 暂缓决策

以下问题在 P0 期间必须明确，未明确前不进入生产切换：

- RetrievalInput.Threshold 是否在 RAGLite 首版只允许为零。
- 是否接受 PDF PageNumber=0，以及前端如何展示位置。
- RAGFlow 是否能导出所有原文件、metadata 和公共 ID。
- sidecar 的备份窗口、磁盘上限和文档大小上限。
- RAGLite 运行时是否允许 Pandoc 格式，及其固定版本。

## 13. 实施目录结构

目录按“公共产品边界、Provider 适配、Provider 实现、部署和运行数据”分层。Go Control Plane
不读取 RAGLite 的数据库文件；Python sidecar 也不读取 Go 的内部包。

当前 sidecar 规模较小，采用文件级分层；达到需要独立维护多组 API 或 application service 时再拆
子包，避免只为目录形式增加空壳。依赖方向保持为 `api -> service -> repository/backend/store`。

~~~text
internal/
  ports/
    knowledge.go                  # 唯一公共 KnowledgeProvider 接口
    contracttest/
      fakes.go                    # 只用于契约测试，不用于真实运行
  domain/
    models.go                     # Provider-neutral 领域值
    common.go                     # 公共错误、分页和 Actor Context
  adapters/
    knowledgefactory/
      factory.go                  # 根据配置装配一个 Knowledge Provider
    knowledgeid/
      codec.go                    # Collection/Document/Chunk 公共 ID
    ragflow/
      client.go                   # RAGFlow HTTP 协议
      provider.go                 # ports.KnowledgeProvider 映射
      types.go                    # RAGFlow 私有 wire 类型
    raglite/
      client.go                   # sidecar HTTP 客户端
      provider.go                 # sidecar -> ports.KnowledgeProvider 映射
      types.go                    # sidecar 私有 wire 类型
  platform/
    httpserver/
      knowledge.go                # 面向插件的 REST 管理 API
    knowledgemcp/
      handler.go                  # Knowledge MCP 工具和授权收敛
  knowledgeeval/
    ...                            # Provider-neutral 检索评测

providers/
  raglite/
    pyproject.toml                # Python 依赖和固定版本
    uv.lock                       # 完整依赖 lockfile
    Dockerfile                    # 固定基础镜像、单 worker、非 root runtime
    healthcheck.py                # 容器内带 Bearer Token 的健康检查
    src/aegis_raglite_provider/
      main.py                     # FastAPI/Uvicorn 入口
      config.py                   # 数据目录、模型和限制
      api.py                      # REST、鉴权依赖和稳定错误响应
      service.py                  # 生命周期、检索编排和单写 worker
      models.py                   # sidecar 内部资源模型
      repository.py               # provider.sqlite schema 与事务
      backend.py                  # RAGLite/DuckDB 唯一封装边界
      original_store.py           # 原子上传、路径约束、下载和删除
    tests/                        # API、service、repository、backend 和文件测试

deploy/
  raglite/
    compose.yaml                  # sidecar、卷、内部网络和 healthcheck
    README.md                      # 启动、备份、恢复和资源要求

scripts/
  test-raglite-deploy.sh          # Compose 与密钥初始化契约

/var/lib/aegis/raglite/            # 运行时挂载卷，不进入 Git
  provider.sqlite                  # Provider 资源、状态、job 的事实来源
  raglite.db                       # RAGLite Document、Chunk、Embedding、索引
  originals/                       # 原文件；路径由 SQLite 相对路径记录
    <collection-id>/
      <document-id>/
        <sanitized-name>
  tmp/                              # 上传中间文件，失败后可清理
  model-cache/                     # Embedding/SaT 缓存，可重建但需固定版本
~~~

### 13.1 各层的访问约束

| 层 | 可以依赖 | 不可以依赖 |
| --- | --- | --- |
| `internal/ports`、`domain` | Aegis 稳定类型 | RAGFlow/RAGLite SDK、Provider ID |
| `internal/adapters/raglite` | sidecar HTTP contract、ID codec | Python 内部模块、DuckDB 文件 |
| `providers/raglite/api.py` | application service、认证 | 直接拼 SQL、直接访问 DuckDB |
| `providers/raglite/service.py` | repository、RAGLite facade、原文件 store | FastAPI request/response 对象 |
| `providers/raglite/repository.py`、`backend.py`、`original_store.py` | SQLite、DuckDB、文件系统、RAGLite | Grafana、Control Plane 内存状态 |
| `deploy/raglite` | 镜像、卷、secret、网络 | 业务逻辑、Provider 映射 |

### 13.2 数据所有权

- `ports` 和 `domain` 只定义契约，不保存知识库数据。
- Go adapter 只做协议转换、ID 转换、超时和错误映射。
- sidecar 的 `provider.sqlite` 是 Collection/Document/job 生命周期的事实来源。
- RAGLite 的 `raglite.db` 是 Chunk、Embedding 和检索索引的事实来源。
- `originals/` 是下载、重新索引和灾备所需的原文件来源。
- Control Plane 不创建 `knowledge_documents`、`provider_mapping` 或公共检索缓存表。
