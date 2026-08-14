# Control Plane Agent runtime

Control Plane 镜像固定打包 Codex CLI/App Server 0.144.4，并在进程握手时再次校验运行版本。镜像以非 root 用户运行，默认工作目录为 `/workspace`，Codex 原生数据目录为 `/var/lib/aegis/codex`。

Codex 部署至少需要挂载：

- `/var/lib/aegis/codex`：Provider 原生会话与认证数据；必须纳入备份和恢复演练。
- `/workspace`：Agent 可见的绝对工作目录。
- `AEGIS_AGENT_ID_KEY_FILE` 指向的 32 字节 ID 密钥文件；密钥丢失后既有公共 Session ID 无法解码。
- `AEGIS_PLUGIN_TOKEN_FILE` 指向的插件代理令牌文件。

同时配置 `AEGIS_AGENT_PROVIDER=codex`、唯一受信 Actor 的 `AEGIS_AGENT_TENANT_ID`、`AEGIS_AGENT_ORG_ID` 和 `AEGIS_AGENT_USER_ID`。首版只允许这一 Actor 使用 Agent API；这不是多用户隔离实现。

OpenCode 使用外部长运行 Server，配置 `AEGIS_AGENT_PROVIDER=opencode`、`AEGIS_AGENT_URL`、`AEGIS_OPENCODE_USERNAME` 和 `AEGIS_OPENCODE_PASSWORD_FILE`。OpenCode 数据目录及备份由 OpenCode 部署负责，不能挂载或复制到 Control Plane 充当会话副本。

当前尚未提供统一的 Agent MCP 配置注入和启动清单校验。部署不得仅因为 Grafana MCP 或 Dagu API 可访问，就宣称 Agent 已注册对应 MCP；完成 Codex/OpenCode 两套原生配置及启动校验前，该验收项保持未完成。
