# RAGLite Knowledge Provider

这是默认的轻量 Knowledge 叠加部署。它运行一个 Python sidecar，持有
`provider.sqlite`、RAGLite DuckDB、原文件和模型缓存；Control Plane 只通过内部 REST 访问。

## 启动

```sh
AEGIS_INIT_KNOWLEDGE_SECRETS=1 ./scripts/init-local-secrets.sh
docker compose -f compose.yaml -f deploy/raglite/compose.yaml up -d --build --wait
```

`AEGIS_KNOWLEDGE_PROVIDER` 未设置时，Knowledge 密钥初始化默认选择 `raglite`，会生成
`knowledge-provider-token`，不需要 RAGFlow API Key。部署前可运行
`make raglite-deploy-test` 校验 Compose 隔离约束和两种 Provider 的密钥初始化行为。
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

RAGFlow 回退部署继续使用根目录 `compose.knowledge.yaml`，两套 Knowledge 叠加文件不能同时启用。
回退初始化必须显式执行
`AEGIS_INIT_KNOWLEDGE_SECRETS=1 AEGIS_KNOWLEDGE_PROVIDER=ragflow ./scripts/init-local-secrets.sh`。
