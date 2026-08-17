# 本地容器完整重编译与启动

本文记录本地 Aegis SRE 主栈叠加 RAGLite Knowledge Provider 时的完整重编译、启动和验收流程。
该流程保留命名卷中的 Grafana、Dagu、Canvas 和 Knowledge 数据，但不会复用旧镜像构建层。

## 适用范围与数据保护

以下命令必须始终同时指定根 Compose 和 RAGLite 叠加文件：

```sh
docker compose -f compose.yaml -f deploy/raglite/compose.yaml ...
```

不得在需要保留数据时执行 `docker compose down -v`。`-v` 会删除包括 `raglite-data` 在内的命名卷，
其中的文档原件、Provider SQLite、RAGLite DuckDB 和模型缓存都可能丢失。完整重编译只需要删除容器、
网络和镜像构建缓存，不需要删除数据卷。

## 1. 启动前检查

初始化本地密钥，并确认 Compose 要绑定的 Knowledge secret 都是非空普通文件：

```sh
AEGIS_INIT_KNOWLEDGE_SECRETS=1 ./scripts/init-local-secrets.sh
for secret_path in \
  deploy/local/secrets/knowledge-id-key \
  deploy/local/secrets/knowledge-mcp-token \
  deploy/local/secrets/knowledge-provider-token
do
  test -f "$secret_path" && test -s "$secret_path" || exit 1
done
docker compose -f compose.yaml -f deploy/raglite/compose.yaml config --quiet
make raglite-deploy-test
```

如果一个尚不存在的宿主机文件路径被 Docker 当作 bind mount 使用，Docker 可能在该位置创建目录。
此时密钥初始化脚本会因为目标“已经存在”而不再生成文件。只在确认该路径确实为空目录后修复：

```sh
ls -ld deploy/local/secrets/knowledge-provider-token
rmdir deploy/local/secrets/knowledge-provider-token
AEGIS_INIT_KNOWLEDGE_SECRETS=1 ./scripts/init-local-secrets.sh
```

不要递归删除整个 secrets 目录，也不要把密钥内容打印到终端或提交到 Git。

## 2. 停止、无缓存构建并重新创建

```sh
docker compose -f compose.yaml -f deploy/raglite/compose.yaml down --remove-orphans
docker compose -f compose.yaml -f deploy/raglite/compose.yaml build --no-cache --pull
docker compose -f compose.yaml -f deploy/raglite/compose.yaml \
  up -d --force-recreate --remove-orphans --wait
```

RAGLite 镜像需要安装完整锁定依赖，并可能源码编译 `llama-cpp-python`。Intel Mac 上通过 Docker 的
Linux/amd64 环境构建通常需要十分钟以上；这不是卡死。`--no-cache` 用于确认镜像能从零构建，日常迭代
可去掉它以复用 Docker 构建缓存。

## 3. 状态与日志验收

```sh
docker compose -f compose.yaml -f deploy/raglite/compose.yaml ps --all
docker compose -f compose.yaml -f deploy/raglite/compose.yaml logs \
  --tail=200 control-plane raglite-provider opencode
docker compose -f compose.yaml -f deploy/raglite/compose.yaml exec -T control-plane \
  wget -qO- http://127.0.0.1:8080/health/ready
curl --fail --silent http://localhost:3000/api/health
make raglite-deploy-test
```

验收标准：

- 长期运行的服务都是 `healthy` 或 `running`，且没有持续重启；
- `grafana-bootstrap` 是一次性初始化任务，`Exited (0)` 是正常状态；
- Control Plane `/health/ready` 返回 HTTP 200，`knowledge` capability 为 `available`；
- RAGLite 日志中没有导入错误、DuckDB 扩展下载错误或模型加载错误；
- `raglite-provider` 只连接内部 `aegis-knowledge` 网络，不发布宿主机端口。

需要检查重启次数、健康探针和网络时，可执行：

```sh
RAGLITE_CONTAINER_ID="$(docker compose -f compose.yaml -f deploy/raglite/compose.yaml ps -q raglite-provider)"
docker inspect "$RAGLITE_CONTAINER_ID" \
  --format 'restart={{.RestartCount}} health={{.State.Health.Status}} networks={{json .NetworkSettings.Networks}}'
```

## 4. RAGLite 镜像的关键约束

这次从零构建和运行确认了以下约束，修改 sidecar 镜像时必须保留对应验证：

- `uv` 将本地 sidecar 以 editable 形式安装到 `/app/.venv`，运行镜像必须同时复制其 `/app/src`；
  只复制虚拟环境会在启动时出现 `ModuleNotFoundError: aegis_raglite_sidecar`。
- 非 root 运行用户必须具有可用的 `HOME`。`/nonexistent` 会使 DuckDB 无法确定扩展目录。
- `aegis-knowledge` 是 internal 网络，运行时不能下载 DuckDB 扩展。因此 `fts` 和 `vss` 必须在镜像
  构建阶段安装，最终镜像还要执行 sidecar import smoke。
- `XDG_DATA_HOME` 仍落在 `/var/lib/aegis/raglite` 数据卷；BGE-M3、SaT 和 tokenizer 必须按固定 revision
  与 SHA-256 构建到只读 `/opt/aegis/models`，运行时不得访问 Hugging Face。

修改这些约束后，至少运行：

```sh
make raglite-sidecar-test
make raglite-image-smoke
make raglite-deploy-test
```

## 5. 模型构建缓存与离线验收

RAGLite 固定使用 BGE-M3 Q4、SaT 和 XLM-R tokenizer。Dockerfile 将模型阶段与业务源码阶段分离，
并使用 `aegis-raglite-models` BuildKit cache 保存已通过 SHA-256 校验的文件。首次构建约下载 850 MB；
同一 builder 的后续构建应直接命中 `models` 两个 `RUN` 层：

```sh
docker compose -f compose.yaml -f deploy/raglite/compose.yaml build raglite-provider
docker compose -f compose.yaml -f deploy/raglite/compose.yaml build raglite-provider
```

第二次构建日志中模型下载、模型复制和最终扩展层都应为 `CACHED`。启动后确认 sidecar 只连接
`aegis-knowledge` internal 网络，日志中没有 Hugging Face/DNS 请求，并在冷启动完成后进入 `healthy`。
不得再通过临时连接默认 bridge 来预热运行容器。

## 6. 常见故障定位

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| sidecar 报 `ModuleNotFoundError` | editable install 的 `/app/src` 未进入运行镜像 | 检查多阶段 Dockerfile，并运行 image smoke |
| secret 路径显示为目录 | Docker 在缺失的 bind-mount 源路径创建了目录 | 确认空目录后 `rmdir`，重新运行密钥初始化 |
| DuckDB 使用 `/nonexistent` 或无法写扩展目录 | 运行用户没有有效 HOME/XDG 目录 | 保持镜像中的 `HOME` 与卷内 XDG 配置 |
| DuckDB 尝试从公网下载 `fts`/`vss` | 扩展没有在构建阶段固化 | 无缓存重建已修复的 sidecar 镜像 |
| 首次 health check 较慢 | 镜像内模型 mmap 和数据库索引初始化 | 等待启动探针；日志不得出现模型下载或 Hub/DNS 请求 |
| `grafana-bootstrap` 已退出 | 一次性初始化任务执行完成 | 退出码为 0 时无需处理 |
