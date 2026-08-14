#!/bin/bash
set -euo pipefail

read_secret() {
  local name="$1"
  local path="$2"
  if [[ ! -r "$path" ]]; then
    echo "RAGFlow secret is missing: $name" >&2
    exit 1
  fi
  local value
  value="$(tr -d '\r\n' < "$path")"
  if [[ -z "$value" ]]; then
    echo "RAGFlow secret is empty: $name" >&2
    exit 1
  fi
  printf '%s' "$value"
}

export MYSQL_PASSWORD="$(read_secret MYSQL_PASSWORD /run/secrets/ragflow-mysql-password)"
export MINIO_PASSWORD="$(read_secret MINIO_PASSWORD /run/secrets/ragflow-minio-password)"
export REDIS_PASSWORD="$(read_secret REDIS_PASSWORD /run/secrets/ragflow-redis-password)"
# Elasticsearch 仅位于内部 Knowledge 网络并关闭自带用户鉴权；跨边界鉴权由 Aegis 完成。
export ELASTIC_PASSWORD=unused

exec /ragflow/entrypoint.sh "$@"
