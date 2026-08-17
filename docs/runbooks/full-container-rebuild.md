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
- `XDG_DATA_HOME`、Hugging Face 和通用模型缓存必须落在 `/var/lib/aegis/raglite` 命名卷内，不能依赖
  容器可写根文件系统。

修改这些约束后，至少运行：

```sh
make raglite-sidecar-test
make raglite-image-smoke
make raglite-deploy-test
```

## 5. 首次模型预热

RAGLite 当前固定使用 BGE-M3 Q4 模型。首次创建 `raglite-data` 卷时，模型缓存约增加 418 MB。
生产镜像应在发布阶段固化经过校验的模型文件；不要给运行中的 Knowledge 网络永久开放公网出口。

当前 `llama-cpp-python` 的 `from_pretrained` 即使发现本地文件，也可能先访问 Hugging Face 枚举仓库。
因此，全新卷或全新进程在完全断网时仍可能启动失败。作为本地开发环境的临时引导，可短暂给单个
sidecar 容器连接默认 bridge，下载固定文件并触发一次长超时健康检查，随后立即断开：

```sh
RAGLITE_CONTAINER_ID="$(docker compose -f compose.yaml -f deploy/raglite/compose.yaml ps -q raglite-provider)"
docker network connect bridge "$RAGLITE_CONTAINER_ID"
docker compose -f compose.yaml -f deploy/raglite/compose.yaml exec -T raglite-provider \
  python -c 'from huggingface_hub import hf_hub_download; hf_hub_download(repo_id="lm-kit/bge-m3-gguf", filename="bge-m3-Q4_K_M.gguf")'
docker compose -f compose.yaml -f deploy/raglite/compose.yaml exec -T raglite-provider \
  python -c 'import urllib.request; print(urllib.request.urlopen("http://127.0.0.1:8090/healthz", timeout=900).read().decode())'
docker network disconnect bridge "$RAGLITE_CONTAINER_ID"
```

无论中间步骤是否成功，都要确认临时 bridge 已断开。上述方法只适用于本地启动，不是生产离线部署
方案，也不能保证以后重新创建容器时完全离线冷启动。后续应把模型 revision、文件校验和离线加载方式
纳入镜像发布流程，再把“新进程无需临时出口”作为正式发布门禁。

## 6. 常见故障定位

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| sidecar 报 `ModuleNotFoundError` | editable install 的 `/app/src` 未进入运行镜像 | 检查多阶段 Dockerfile，并运行 image smoke |
| secret 路径显示为目录 | Docker 在缺失的 bind-mount 源路径创建了目录 | 确认空目录后 `rmdir`，重新运行密钥初始化 |
| DuckDB 使用 `/nonexistent` 或无法写扩展目录 | 运行用户没有有效 HOME/XDG 目录 | 保持镜像中的 `HOME` 与卷内 XDG 配置 |
| DuckDB 尝试从公网下载 `fts`/`vss` | 扩展没有在构建阶段固化 | 无缓存重建已修复的 sidecar 镜像 |
| 首次 health check 超时 | 首次模型下载、mmap 或初始化超过短探针时间 | 查看日志并执行受控预热，不要盲目循环重启 |
| `grafana-bootstrap` 已退出 | 一次性初始化任务执行完成 | 退出码为 0 时无需处理 |
