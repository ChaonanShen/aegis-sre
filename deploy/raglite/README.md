# RAGLite Knowledge Provider

这是默认的轻量 Knowledge 叠加部署。它运行一个 Python sidecar，持有
`provider.sqlite`、RAGLite DuckDB、原文件和模型缓存；Control Plane 只通过内部 REST 访问。

## 启动

```sh
AEGIS_INIT_KNOWLEDGE_SECRETS=1 ./scripts/init-local-secrets.sh
docker compose -f compose.yaml -f deploy/raglite/compose.yaml up -d --build --wait
```

需要从零重建整个本地栈、排查首次模型启动或验收所有容器时，按
[`docs/runbooks/full-container-rebuild.md`](../../docs/runbooks/full-container-rebuild.md) 执行。该流程保留
命名卷数据，明确禁止在有数据时使用 `down -v`。

Knowledge 运行时固定使用 RAGLite，不存在 Provider 选择环境变量。启用
`AEGIS_INIT_KNOWLEDGE_SECRETS=1` 会生成 `knowledge-provider-token`，不需要 RAGFlow API Key。部署前可运行
`make raglite-deploy-test` 校验 Compose 隔离约束和 RAGLite 密钥初始化行为。
发布镜像前运行 `make raglite-image-smoke`，验证固定依赖可构建且 RAGLite、ONNX Runtime 和
llama.cpp 的运行时动态库完整。

sidecar 不发布主机端口，只加入内部 `aegis-knowledge` 网络。首次构建会编译或下载
`llama-cpp-python`，首次索引会下载固定配置的 BGE-M3 Q4 和 SaT 模型，因此不应把首次启动耗时
当作稳态启动时间。生产镜像发布前还要预热并固化模型与 DuckDB FTS/VSS 扩展缓存。

## 测试平台约束

`onnxruntime==1.28.0` 没有 Intel macOS (`x86_64`) wheel，因此该平台不能直接执行
`uv sync --extra test --locked` 的完整锁定依赖安装。完整 sidecar 测试必须在与生产镜像一致的
Linux/amd64 容器中运行；不能通过跳过 ONNX Runtime 或修改锁文件让本地测试假通过。

仓库提供统一容器入口，使用固定 Python 镜像、`uv 0.8.4` 和完整 `uv.lock`：

```sh
make raglite-sidecar-test
make raglite-image-smoke
```

该流程已在 Intel Mac 的 Docker Linux/amd64 VM 中验证，`onnxruntime 1.28.0`、RAGLite 和
`llama-cpp-python` 完整安装，sidecar 测试与 Ruff 均通过。首次执行会源码编译
`llama-cpp-python`，可能需要约 10 分钟；CI 和日常重复执行复用同一 Docker 构建缓存。

## 数据和恢复

停止写入后，把 `raglite-data` 卷作为一致性集合备份。卷内包括：

- `provider.sqlite` 及 WAL：Collection、Document 和 job 生命周期；
- `raglite.db` 及 lock：Chunk、Embedding 和检索索引；
- `originals/`：下载和重新索引所需原文件；
- `model-cache/`：可重建缓存，但恢复时必须匹配模型 revision。

`knowledge-id-key` 和 `knowledge-provider-token` 由 secret manager 单独备份。恢复同一镜像和完整卷
后，先验证 `/healthz`、已知原文件下载和已知检索，再开放写入。不得对需要保留的数据执行
`docker compose down -v`。

根目录 `compose.knowledge.yaml` 和 `deploy/ragflow/` 是退出窗口内冻结的历史资产，不兼容当前固定 RAGLite 的
Control Plane，不能与本叠加文件组合或作为当前版本的运行时切换。需要回退时必须使用发布记录中匹配的旧版本
Control Plane、Compose、密钥和数据快照；禁止让新旧栈同时写入。
