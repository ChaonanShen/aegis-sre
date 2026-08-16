# ADR 0004：Knowledge 公共标识与 Folder 授权

- 状态：已接受
- 日期：2026-08-14
- 适用范围：阶段 8 RAGFlow 与 Knowledge 垂直切片

## 背景

阶段 8 要把 Grafana Plugin、Control Plane、RAGFlow、Knowledge MCP、OpenCode 和 Dagu
完整接通，同时保持 Control Plane 无状态。RAGFlow Dataset/Document ID 是 Provider 内部标识，
不能进入浏览器或 Agent 的公共契约。阶段 8 还要求无权检索 100% 拒绝，而可信的 Folder 授权原本
排在阶段 10，若不前置将只能依赖浏览器可伪造的 `folder_uid`。

RAGFlow 是 Dataset、Document、Chunk、解析状态和检索结果的唯一事实来源。阶段 8 不为资源映射、
幂等或授权增加 Aegis 数据库，也不复制索引。

## 决策

### 公共资源标识

1. KnowledgeBase 公共 ID 由 Control Plane 使用部署密钥，对 Tenant、Grafana Org、Folder UID 和
   `Idempotency-Key` 做 HMAC 派生，格式为 `kbs_*`。RAGFlow Dataset 使用
   `aegis__<public-id>` 作为确定性名称；用户可见名称写入描述或 metadata。
   Knowledge Base 是 Folder-owned 团队资产，因此公共 ID 和 Provider scope 都不得包含创建者 User ID；
   User ID 只参与请求审计，不能改变同一 Folder 内其他合法用户看到的资源集合。
2. Document 公共 ID 由 KnowledgeBase 公共 ID 和 `Idempotency-Key` 做 HMAC 派生，格式为
   `doc_*`。上传给 RAGFlow 的文件名使用确定性内部名称；原始文件名、公共 ID、Service、标签和
   内容 SHA-256 写入 RAGFlow `meta_fields`。
3. Control Plane 通过确定性名称和 metadata 反查 Provider 资源，不保存公共 ID 与 Provider ID
   的映射表。创建重试先按确定性名称或内容摘要对账；结果不确定的变更请求不得自动重试，返回
   `provider_result_unknown` 供调用方查询后决定。
4. 公共 API、日志、错误、MCP 输入输出和浏览器 URL 不返回 RAGFlow Dataset/Document ID。

### Folder 授权

1. 阶段 8 前置 Knowledge 所需的最小 Folder 授权链路。Plugin Backend 使用 Grafana 后端身份和
   RBAC 能力校验当前用户对 `folders:uid:<uid>` 的权限，通过后才注入可信 Folder 上下文。
2. Plugin Backend 删除浏览器传入的 Actor、Org、Role 和 Folder 身份头。Control Plane 只接受
   Plugin Backend 使用内部凭据转发的可信上下文；缺少、格式错误或无权的 Folder 默认拒绝。
3. Dataset 的确定性名称绑定 Tenant/Org/Folder 范围。list/get/update/delete、文档管理和检索都必须
   重新验证当前范围，不能仅凭公共 ID 授权。
4. 此前置只覆盖阶段 8 Knowledge 操作；阶段 10 仍负责全产品生产身份、密钥轮换和更细授权。

### v1 User-scoped 数据兼容

1. 早期实现把 User ID 加入 `CollectionID` 和 `aegis_scope`，这会把 Folder-owned 资源错误收窄为创建者私有。
   新写入使用 v2 Folder scope（Tenant/Org/Folder），RAGFlow metadata 的 `aegis_version` 提升为 `2`。
2. v1 数据不自动归给整个 Folder。兼容窗口内，仅原创建者在相同 Folder 上可读取其 v1 Knowledge Base、Document、
   Chunk、检索和下载内容；update/delete/upload/index 等写操作全部拒绝。
3. RAGLite 没有独立 metadata version，Adapter 使用 v1/v2 scope fingerprint 区分；读取时分别查询并合并，写入只接受
   v2 scope。RAGFlow 使用 metadata version 和 scope 同时判断，不能把缺失或冲突 metadata 当作 v1。
4. 显式迁移必须在目标 Folder 下创建新的 v2 Knowledge Base 并重新上传/索引文档，旧数据保留只读一个到两个发布
   周期；不原地改写 scope，不自动删除。兼容窗口结束后的删除仍遵守旧代码删除确认与回退要求。

### Knowledge MCP

1. MCP 暴露 `knowledge.search`、`knowledge.get_document` 和 `knowledge.list_sources`，只接受公共 ID、
   Service 和业务过滤条件，不接受 Provider ID 或任意 RAGFlow metadata 表达式。
2. 当前单用户部署中，每个 MCP Bearer Token 在服务端绑定一个固定 Actor 和显式 Folder allowlist；
   未配置 Folder 或请求越界时默认拒绝。多用户委托身份必须另行设计，不能信任模型传入的 Actor。
3. MCP 默认最多返回 5 条、上限 10 条；单 Chunk 最多 4 KiB，总响应最多 64 KiB。Dagu 只注册
   只读 Knowledge 工具。
4. 只有真实 RAGFlow 检索、越权和响应限制测试通过后，才向 OpenCode 和 Dagu 注册 Knowledge MCP。

### 部署和失败语义

1. RAGFlow 及其依赖固定版本和镜像 digest，使用独立可选 Compose profile/file，不加入默认
   `local-up`，避免 16 GiB 开发机启动现有链路时被迫运行完整知识栈。
2. Embedding 服务必须显式配置；真实模式没有 API key、Embedding 或 RAGFlow 时直接报告受控降级，
   不回退 fixture/mock。
3. API key 从只读文件加载。只重试幂等的 GET/health 请求；上传、解析、删除等结果不确定的请求不
   自动重试。Provider HTTP 200 中的非零业务码也映射为受控错误。

## 结果

- 可以在不引入影子数据库的前提下恢复公共资源引用并执行授权收敛。
- 公共 ID 不是授权凭据，所有读写仍需要可信 Actor 与 Folder 上下文。
- 依赖 RAGFlow 名称和 metadata 的行为必须由固定版本契约测试保护；升级前要运行真实集成测试。
- 若 RAGFlow 无法可靠按确定性名称或 metadata 恢复资源，暂停实现并提交新的 ADR，不以进程内缓存
  或隐式数据库补洞。
