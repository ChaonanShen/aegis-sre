#!/bin/sh
set -eu

repository_root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
password="$(tr -d '\r\n' < "$repository_root/deploy/local/secrets/dagu-basic-password")"
base_url="http://127.0.0.1:${DAGU_PORT:-18081}/api/v1"
credentials="aegis-control-plane:$password"
spec="$(cat "$repository_root/deploy/local/grafana-mcp-smoke.yaml")"
create_response="$(mktemp "${TMPDIR:-/tmp}/aegis-smoke-create.XXXXXX")"
trap 'rm -f "$create_response"' EXIT

create_status="$(curl -sS -o "$create_response" -w '%{http_code}' -u "$credentials" -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg name grafana-mcp-smoke --arg spec "$spec" '{name:$name,spec:$spec}')" "$base_url/dags")"
case "$create_status" in
  2??) ;;
  409) curl -fsS -u "$credentials" -X PUT -H 'Content-Type: application/json' -d "$(jq -nc --arg spec "$spec" '{spec:$spec}')" "$base_url/dags/grafana-mcp-smoke/spec" >/dev/null ;;
  *) cat "$create_response" >&2; exit 1 ;;
esac

run_id="run_smoke_$(date +%s)"
curl -fsS -u "$credentials" -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg name grafana-mcp-smoke --arg run "$run_id" '{dagName:$name,dagRunId:$run,params:"{}"}')" \
  "$base_url/dags/grafana-mcp-smoke/start" | jq -e --arg run "$run_id" '.dagRunId == $run' >/dev/null

attempt=0
status=queued
while [ "$attempt" -lt 60 ]; do
  details="$(curl -fsS -u "$credentials" "$base_url/dag-runs/grafana-mcp-smoke/$run_id")"
  status="$(printf '%s' "$details" | jq -r .dagRunDetails.statusLabel)"
  case "$status" in
    succeeded) break ;;
    failed|rejected|aborted|cancelled) printf '%s' "$details" | jq '.dagRunDetails.nodes' >&2; exit 1 ;;
  esac
  sleep 1
  attempt=$((attempt + 1))
done
test "$status" = succeeded
curl -fsS -u "$credentials" "$base_url/dag-runs/grafana-mcp-smoke/$run_id/artifacts/preview?path=reports%2Fgrafana-mcp-smoke.md" \
  | jq -e '.content | contains("authenticated Grafana MCP")' >/dev/null
echo "Local Playbook smoke passed: Grafana Plugin stack, Dagu mcp.call, Grafana MCP, and artifact ($run_id)."
