#!/bin/sh
set -eu

repository_root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
password="$(tr -d '\r\n' < "$repository_root/deploy/local/secrets/grafana-admin-password")"
base_url="http://127.0.0.1:${GRAFANA_PORT:-3000}/api/plugins/grafana-plugin-app/resources/api/v1"
authorization="Basic $(printf 'admin:%s' "$password" | base64)"
source_file="$repository_root/deploy/playbooks/examples/node-health-summary.yaml"
playbook_id=''

running="$(docker compose -f "$repository_root/compose.yaml" ps --services --status running)"
if printf '%s\n' "$running" | grep -qx 'ragflow'; then
  echo 'RAGFlow is running; node health smoke must not depend on Knowledge.' >&2
  exit 1
fi

request() {
  method="$1"
  path="$2"
  shift 2
  curl -fsS -X "$method" "$base_url$path" -H "Authorization: $authorization" "$@"
}

cleanup() {
  if [ -n "$playbook_id" ]; then
    request DELETE "/playbooks/$playbook_id" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

playbook_id="$(request POST /playbooks -H 'Content-Type: application/yaml' -H "Idempotency-Key: node-health-playbook-$(date +%s)" --data-binary "@$source_file" | jq -r '.id')"
test -n "$playbook_id" -a "$playbook_id" != null

run_id="$(request POST "/playbooks/$playbook_id/runs" -H 'Content-Type: application/json' -H "Idempotency-Key: node-health-run-$(date +%s)" --data '{}' | jq -r '.id')"
if [ -z "$run_id" ] || [ "$run_id" = null ]; then
  echo 'failed to start node health playbook' >&2
  exit 1
fi

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

artifacts="$(request GET "/runs/$run_id/artifacts")"
printf '%s\n' "$artifacts" | jq -e '.items | any(.path == "reports/node-health-summary.md")' >/dev/null
preview="$(request GET "/runs/$run_id/artifacts/preview?path=reports%2Fnode-health-summary.md")"
printf '%s\n' "$preview" | jq -e '.text | contains("Node health summary")' >/dev/null
printf 'Node health Playbook smoke passed: %s / %s\n' "$playbook_id" "$run_id"
