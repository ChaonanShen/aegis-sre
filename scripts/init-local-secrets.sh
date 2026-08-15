#!/bin/sh
set -eu

secret_dir="${1:-deploy/local/secrets}"
mkdir -p "$secret_dir"
chmod 700 "$secret_dir"

generate() {
  target="$secret_dir/$1"
  if [ ! -e "$target" ]; then
    umask 077
    openssl rand -hex 32 > "$target"
  fi
}

generate_raw() {
  target="$secret_dir/$1"
  if [ ! -e "$target" ]; then
    umask 077
    openssl rand 32 > "$target"
  fi
}

generate plugin-token
generate grafana-mcp-caller-token
generate dagu-basic-password
generate grafana-admin-password
generate opencode-server-password
generate playbook-mcp-token
generate canvas-mcp-token
generate_raw agent-id-key

if [ "${AEGIS_INIT_KNOWLEDGE_SECRETS:-0}" = "1" ]; then
  generate_raw knowledge-id-key
  generate knowledge-mcp-token
  generate ragflow-mysql-password
  generate ragflow-minio-password
  generate ragflow-redis-password
fi

if [ ! -s "$secret_dir/deepseek-api-key" ]; then
  echo "Missing $secret_dir/deepseek-api-key; write the DeepSeek API key to that file before local-up." >&2
  exit 1
fi

if [ "${AEGIS_INIT_KNOWLEDGE_SECRETS:-0}" = "1" ] && [ ! -s "$secret_dir/ragflow-api-key" ]; then
  echo "Missing $secret_dir/ragflow-api-key; create an API key in the RAGFlow account used by Aegis before knowledge-up." >&2
  exit 1
fi

# Compose bind-mounts these files into non-root containers. The containing directory is
# private and gitignored; files remain read-only from the containers' perspective.
chmod 644 "$secret_dir"/*
echo "Local secret files are ready in $secret_dir"
