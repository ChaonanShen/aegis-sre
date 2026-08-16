#!/bin/sh
set -eu

repository_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT HUP INT TERM

compose_json="$test_root/compose.json"
docker compose \
  -f "$repository_root/compose.yaml" \
  -f "$repository_root/deploy/raglite/compose.yaml" \
  config --format json > "$compose_json"

jq -e --arg root "$repository_root" '
  .services["raglite-provider"] as $provider
  | $provider.build.context == $root
  and $provider.build.dockerfile == "internal/adapters/raglite/sidecar/Dockerfile"
  and $provider.read_only == true
  and (($provider.ports // []) | length == 0)
  and ($provider.networks | has("aegis-knowledge"))
  and .networks["aegis-knowledge"].internal == true
  and any($provider.volumes[];
    .type == "volume" and .target == "/var/lib/aegis/raglite")
  and any($provider.volumes[];
    .type == "bind" and .target == "/run/secrets/knowledge-provider-token" and .read_only)
  and (.services["control-plane"].environment | has("AEGIS_KNOWLEDGE_PROVIDER") | not)
' "$compose_json" >/dev/null

raglite_secrets="$test_root/raglite"
mkdir -p "$raglite_secrets"
printf '%s\n' test-key > "$raglite_secrets/deepseek-api-key"
AEGIS_INIT_KNOWLEDGE_SECRETS=1 \
  "$repository_root/scripts/init-local-secrets.sh" "$raglite_secrets" >/dev/null
test -s "$raglite_secrets/knowledge-id-key"
test -s "$raglite_secrets/knowledge-mcp-token"
test -s "$raglite_secrets/knowledge-provider-token"
test ! -e "$raglite_secrets/ragflow-mysql-password"

echo "RAGLite deployment contracts passed"
