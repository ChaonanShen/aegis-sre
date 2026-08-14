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
export OPENCODE_SERVER_PASSWORD="$(read_secret OPENCODE_SERVER_PASSWORD /run/secrets/opencode-server-password)"
export OPENCODE_SERVER_USERNAME=opencode

# 1.18.18 的 V2 Session Runner 不稳定地解析 Provider 环境凭据；把 Key 注入仅存在于 tmpfs 的
# 运行时配置，使 V1 CLI 和 V2 Server 使用同一凭据，同时避免写入镜像或持久卷。
runtime_config=/workspace/opencode.json
node - "$OPENCODE_CONFIG" "$runtime_config" <<'NODE'
const fs = require('fs');
const [source, target] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(source, 'utf8'));
config.provider.deepseek.options = { ...config.provider.deepseek.options, apiKey: process.env.DEEPSEEK_API_KEY };
fs.writeFileSync(target, JSON.stringify(config), { mode: 0o600 });
NODE
export OPENCODE_CONFIG="$runtime_config"

# 启动前必须确认声明的 MCP 能完成握手，避免健康但没有 SRE 工具的伪可用状态。
opencode mcp list --pure
exec opencode serve --pure --print-logs --log-level INFO --hostname 0.0.0.0 --port 4096
