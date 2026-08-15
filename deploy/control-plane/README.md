# Control Plane Agent runtime

Control Plane 镜像固定打包 Codex CLI/App Server 0.144.4，并在进程握手时再次校验运行版本。镜像以非 root 用户运行，默认工作目录为 `/workspace`，Codex 原生数据目录为 `/var/lib/aegis/codex`。

Codex 部署至少需要挂载：

- `/var/lib/aegis/codex`：Provider 原生会话与认证数据；必须纳入备份和恢复演练。
- `/workspace`：Agent 可见的绝对工作目录。
- `AEGIS_AGENT_ID_KEY_FILE` 指向的 32 字节 ID 密钥文件；密钥丢失后既有公共 Session ID 无法解码。
- `AEGIS_PLUGIN_TOKEN_FILE` 指向的插件代理令牌文件。

同时配置 `AEGIS_AGENT_PROVIDER=codex`、唯一受信 Actor 的 `AEGIS_AGENT_TENANT_ID`、`AEGIS_AGENT_ORG_ID` 和 `AEGIS_AGENT_USER_ID`。首版只允许这一 Actor 使用 Agent API；这不是多用户隔离实现。

OpenCode 使用外部长运行 Server，配置 `AEGIS_AGENT_PROVIDER=opencode`、`AEGIS_AGENT_URL`、`AEGIS_OPENCODE_USERNAME` 和 `AEGIS_OPENCODE_PASSWORD_FILE`。根 Compose 固定部署 OpenCode 1.18.18，使用 DeepSeek `deepseek-chat`，并把 `/var/lib/opencode` 作为 Provider 原生持久卷。DeepSeek Key、Server Basic Auth 和 Grafana MCP Token 均从只读 secret 文件加载，不能写入 Compose 环境或镜像。OpenCode 数据目录及备份由 OpenCode 部署负责，不能挂载或复制到 Control Plane 充当会话副本。

OpenCode 在启动 Server 前执行 `opencode mcp list`，任何声明启用的 Grafana Read 或 Knowledge MCP 不能完成握手时启动失败。Knowledge override 使用只读 Token 文件访问 Control Plane `/mcp/knowledge`，Token 在服务端绑定固定 Actor 和 Folder allowlist。Dagu 使用同一个端点，但由 `mcp.call` 配置再次限制为三个只读 Knowledge 工具。
