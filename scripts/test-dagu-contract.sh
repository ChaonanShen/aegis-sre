#!/bin/sh
set -eu

repository_root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
compose_file="$repository_root/deploy/dagu/compose.contract.yaml"
mkdir -p "$repository_root/deploy/dagu/data"
temporary_dir="$(mktemp -d "$repository_root/deploy/dagu/data/contract.XXXXXX")"
export CONTRACT_PASSWORD_FILE="$temporary_dir/dagu-password"
export CONTRACT_TOKEN_FILE="$temporary_dir/mcp-token"
export CONTRACT_DAGU_PORT="${CONTRACT_DAGU_PORT:-18082}"
printf '%s' 'contract-password' > "$CONTRACT_PASSWORD_FILE"
printf '%s' 'contract-caller-token' > "$CONTRACT_TOKEN_FILE"
chmod 644 "$CONTRACT_PASSWORD_FILE" "$CONTRACT_TOKEN_FILE"

cleanup() {
  docker compose -f "$compose_file" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$temporary_dir"
}
trap cleanup EXIT INT TERM

if ! docker compose -f "$compose_file" up --build --wait --quiet-pull; then
  docker compose -f "$compose_file" logs --no-color >&2
  exit 1
fi

base_url="http://127.0.0.1:$CONTRACT_DAGU_PORT/api/v1"
credentials="contract:contract-password"
spec="$(cat "$repository_root/deploy/dagu/dags/mcp-call-contract.yaml")"
curl -fsS -u "$credentials" -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg name mcp-call-contract --arg spec "$spec" '{name:$name,spec:$spec}')" \
  "$base_url/dags" >/dev/null

run_id="run_contract_$(date +%s)"
response="$(curl -fsS -u "$credentials" -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg name mcp-call-contract --arg run "$run_id" '{dagName:$name,dagRunId:$run,params:"{}"}')" \
  "$base_url/dags/mcp-call-contract/start")"
actual_run_id="$(printf '%s' "$response" | jq -er .dagRunId)"
test "$actual_run_id" = "$run_id"

attempt=0
status=queued
while [ "$attempt" -lt 60 ]; do
  details="$(curl -fsS -u "$credentials" "$base_url/dag-runs/mcp-call-contract/$run_id")"
  status="$(printf '%s' "$details" | jq -r .dagRunDetails.statusLabel)"
  case "$status" in
    succeeded) break ;;
    failed|rejected|aborted|cancelled)
      printf '%s' "$details" | jq '.dagRunDetails.nodes[] | select(.statusLabel != "succeeded") | {id:.step.id,status:.statusLabel,error}' >&2
      exit 1
      ;;
  esac
  sleep 1
  attempt=$((attempt + 1))
done
test "$status" = succeeded
printf '%s' "$details" | jq -e '[.dagRunDetails.nodes[] | select(.step.id | startswith("query_"))] | length == 4 and all(.statusLabel == "succeeded")' >/dev/null

artifact="$(curl -fsS -u "$credentials" "$base_url/dag-runs/mcp-call-contract/$run_id/artifacts/preview?path=reports%2Fmcp-contract.md")"
printf '%s' "$artifact" | jq -e '.content | contains("metrics") and contains("dashboards")' >/dev/null
echo "Dagu contract passed: four parallel mcp.call steps and report artifact ($run_id)."
