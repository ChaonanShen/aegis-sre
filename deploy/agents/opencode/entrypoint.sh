#!/bin/sh
set -eu

read_secret() {
  name="$1"
  path="$2"
  if [ ! -r "$path" ]; then
    echo "OpenCode secret is missing: $name" >&2
    exit 1
  fi
  value="$(tr -d '\r\n' < "$path")"
  if [ -z "$value" ]; then
    echo "OpenCode secret is empty: $name" >&2
    exit 1
  fi
  printf '%s' "$value"
}

export DEEPSEEK_API_KEY="$(read_secret DEEPSEEK_API_KEY /run/secrets/deepseek-api-key)"
export GRAFANA_MCP_TOKEN="$(read_secret GRAFANA_MCP_TOKEN /run/secrets/grafana-mcp-caller-token)"
export PLAYBOOK_MCP_TOKEN="$(read_secret PLAYBOOK_MCP_TOKEN /run/secrets/playbook-mcp-token)"
export CANVAS_MCP_TOKEN="$(read_secret CANVAS_MCP_TOKEN /run/secrets/canvas-mcp-token)"
if [ -n "${KNOWLEDGE_MCP_URL:-}" ]; then
  export KNOWLEDGE_MCP_TOKEN="$(read_secret KNOWLEDGE_MCP_TOKEN /run/secrets/knowledge-mcp-token)"
fi
export OPENCODE_SERVER_PASSWORD="$(read_secret OPENCODE_SERVER_PASSWORD /run/secrets/opencode-server-password)"
export OPENCODE_SERVER_USERNAME=opencode
export XDG_DATA_HOME=/workspace/.local/share

# 1.18.18 的 V2 Session Runner 不稳定地解析 Provider 环境凭据；把 Key 注入仅存在于 tmpfs 的
# 运行时配置，使 V1 CLI 和 V2 Server 使用同一凭据，同时避免写入镜像或持久卷。
runtime_config=/workspace/opencode.json
node - "$OPENCODE_CONFIG" "$runtime_config" <<'NODE'
const fs = require('fs');
const [source, target] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(source, 'utf8'));
config.provider.deepseek.options = { ...config.provider.deepseek.options, apiKey: process.env.DEEPSEEK_API_KEY };
if (process.env.KNOWLEDGE_MCP_URL) {
  config.mcp['knowledge-read'] = {
    type: 'remote', url: process.env.KNOWLEDGE_MCP_URL, oauth: false, enabled: true, timeout: 30000,
    headers: { Authorization: 'Bearer {env:KNOWLEDGE_MCP_TOKEN}' },
  };
}
fs.writeFileSync(target, JSON.stringify(config), { mode: 0o600 });
NODE
export OPENCODE_CONFIG="$runtime_config"

# V2 Session Runner 只从 OpenCode credential store 解析 Provider 密钥。该文件写入
# /workspace tmpfs，容器停止后即销毁，不进入镜像或持久化的 OpenCode 数据卷。
mkdir -p "$XDG_DATA_HOME/opencode"
node - "$XDG_DATA_HOME/opencode/auth.json" <<'NODE'
const fs = require('fs');
const [target] = process.argv.slice(2);
fs.writeFileSync(target, JSON.stringify({ deepseek: { type: 'api', key: process.env.DEEPSEEK_API_KEY } }), { mode: 0o600 });
NODE

# 启动前必须确认声明的 MCP 能完成握手，避免健康但没有 SRE 工具的伪可用状态。
opencode mcp list --pure
exec opencode serve --pure --print-logs --log-level INFO --hostname 0.0.0.0 --port 4096
