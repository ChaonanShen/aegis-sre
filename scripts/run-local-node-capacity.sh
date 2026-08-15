#!/bin/sh
set -eu

repository_root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
password="$(tr -d '\r\n' < "$repository_root/deploy/local/secrets/grafana-admin-password")"
base_url="http://127.0.0.1:${GRAFANA_PORT:-3000}/api/plugins/grafana-plugin-app/resources/api/v1"
authorization="Basic $(printf 'admin:%s' "$password" | base64)"
source_file="$repository_root/deploy/playbooks/examples/node-capacity-summary.yaml"

running="$(docker compose -f "$repository_root/compose.yaml" ps --services --status running)"
if printf '%s\n' "$running" | grep -qx 'ragflow'; then
  echo 'RAGFlow is running; capacity Playbook must not depend on Knowledge.' >&2
  exit 1
fi

request() {
  method="$1"
  path="$2"
  shift 2
  curl -fsS -X "$method" "$base_url$path" -H "Authorization: $authorization" "$@"
}

# 固定创建键让同一个 Playbook 保留，多次执行只新增 Run 历史。
playbook_id="$(request POST /playbooks -H 'Content-Type: application/yaml' -H 'Idempotency-Key: node-capacity-local-v2' --data-binary "@$source_file" | jq -r '.id')"
test -n "$playbook_id" -a "$playbook_id" != null

run_key="node-capacity-run-$(date +%s)-$$"
run_id="$(request POST "/playbooks/$playbook_id/runs" -H 'Content-Type: application/json' -H "Idempotency-Key: $run_key" --data '{}' | jq -r '.id')"
test -n "$run_id" -a "$run_id" != null

status='queued'
attempt=0
while [ "$attempt" -lt 90 ]; do
  run="$(request GET "/runs/$run_id")"
  status="$(printf '%s' "$run" | jq -r '.status')"
  case "$status" in
    succeeded) break ;;
    failed|cancelled) printf '%s\n' "$run" | jq . >&2; exit 1 ;;
  esac
  sleep 1
  attempt=$((attempt + 1))
done
test "$status" = succeeded

preview="$(request GET "/runs/$run_id/artifacts/preview?path=reports%2Fnode-capacity-summary.md")"
report="$(printf '%s\n' "$preview" | jq -r '.text')"
printf '%s\n' "$report" | grep -q '<!-- result:disk -->'
printf '%s\n' "$report" | grep -q '<!-- result:memory -->'
printf '%s\n' "$report" | grep -Eq 'Root disk remaining: \*\*[0-9]+([.][0-9]+)? GiB\*\*'
printf '%s\n' "$report" | grep -Eq 'Memory used: \*\*[0-9]+([.][0-9]+)? GiB\*\*'
if printf '%s\n' "$report" | grep -q '"data"'; then
  echo 'capacity report unexpectedly contains raw Grafana MCP JSON' >&2
  exit 1
fi

printf 'Node capacity Playbook succeeded: %s / %s\n\n' "$playbook_id" "$run_id"
printf '%s\n' "$report"
