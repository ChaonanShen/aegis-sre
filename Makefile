.PHONY: verify contracts-generate contracts-check contracts-go-generate contracts-go-check contracts-ts-generate contracts-ts-check control-plane-test control-plane-build dagu-validate node-health-playbook-validate dagu-contract-test grafana-mcp-config-check grafana-mcp-smoke local-secrets local-config-check local-up local-agent-smoke local-playbook-smoke local-node-health-smoke agent-playbook-e2e local-smoke codex-schema-check plugin-backend-test plugin-backend-build plugin-typecheck plugin-lint plugin-test plugin-build

OAPI_CODEGEN_VERSION := v2.8.0
MAGE_VERSION := v1.17.2
DAGU_VERSION := v2.13.0
DAGU_BIN ?= dagu
CODEX_VERSION := 0.144.4
CODEX_BIN ?= codex

verify: contracts-check codex-schema-check control-plane-test control-plane-build dagu-validate grafana-mcp-config-check plugin-backend-test plugin-backend-build plugin-typecheck plugin-lint plugin-test plugin-build

contracts-generate: contracts-go-generate contracts-ts-generate

contracts-go-generate:
	go run github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@$(OAPI_CODEGEN_VERSION) --config api/oapi-codegen.yaml api/openapi.yaml

contracts-ts-generate:
	npm --prefix grafana-plugin run contracts:generate

contracts-check: contracts-go-check contracts-ts-check

contracts-go-check: contracts-go-generate
	git diff --exit-code -- internal/contracts/apiv1/generated.go

contracts-ts-check: contracts-ts-generate
	git diff --exit-code -- grafana-plugin/src/api/generated/controlPlane.ts grafana-plugin/src/api/generated/events.ts

control-plane-test:
	go test ./...

control-plane-build:
	go build ./...

dagu-validate:
	dagu_tmp=$$(mktemp -d); \
	trap 'rm -rf "$$dagu_tmp"' EXIT; \
	cp deploy/dagu/base.yaml "$$dagu_tmp/base.yaml"; \
	  $(DAGU_BIN) validate --dagu-home "$$dagu_tmp" -c deploy/dagu/config.yaml deploy/dagu/dags/mcp-call-contract.yaml

node-health-playbook-validate:
	dagu_tmp=$$(mktemp -d); \
	trap 'rm -rf "$$dagu_tmp"' EXIT; \
	cp deploy/dagu/base.yaml "$$dagu_tmp/base.yaml"; \
	$(DAGU_BIN) validate --dagu-home "$$dagu_tmp" -c deploy/dagu/config.yaml deploy/playbooks/examples/node-health-summary.yaml

dagu-contract-test:
	./scripts/test-dagu-contract.sh

grafana-mcp-config-check:
	GRAFANA_URL=http://grafana:3000 GRAFANA_READ_TOKEN_FILE=/run/secrets/read GRAFANA_WRITE_TOKEN_FILE=/run/secrets/write docker compose -f deploy/grafana-mcp/compose.yaml config --quiet

# 真实冒烟验收显式要求两个 datasource UID，避免以 fixture 假装 Grafana 已连通。
grafana-mcp-smoke:
	@: $${GRAFANA_PROMETHEUS_UID:?set GRAFANA_PROMETHEUS_UID}
	@: $${GRAFANA_LOKI_UID:?set GRAFANA_LOKI_UID}
	go run ./cmd/mcp-call --config deploy/mcp/v1/servers.yaml --server grafana-read --tool search_dashboards --args-json '{"query":"","limit":1}'
	go run ./cmd/mcp-call --config deploy/mcp/v1/servers.yaml --server grafana-read --tool query_prometheus --args-json "{\"datasourceUid\":\"$$GRAFANA_PROMETHEUS_UID\",\"expr\":\"up\",\"endTime\":\"now\",\"queryType\":\"instant\"}"
	go run ./cmd/mcp-call --config deploy/mcp/v1/servers.yaml --server grafana-read --tool query_loki_logs --args-json "{\"datasourceUid\":\"$$GRAFANA_LOKI_UID\",\"logql\":\"{job=~\\\".+\\\"}\",\"limit\":1}"
	go run ./cmd/mcp-call --config deploy/mcp/v1/servers.yaml --server grafana-read --tool alerting_manage_rules --args-json '{"operation":"list","limit":1}'

local-secrets:
	./scripts/init-local-secrets.sh

local-config-check:
	docker compose config --quiet

local-up: local-secrets plugin-backend-build plugin-build
	docker compose up --build --wait

local-smoke:
	./scripts/smoke-local-playbook.sh
	./scripts/smoke-local-playbook-api.mjs
	./scripts/smoke-local-agent.mjs

local-agent-smoke:
	./scripts/smoke-local-agent.mjs

agent-playbook-e2e:
	./scripts/smoke-local-agent-playbook.mjs

local-playbook-smoke:
	./scripts/smoke-local-playbook.sh
	./scripts/smoke-local-playbook-api.mjs

local-node-health-smoke:
	./scripts/smoke-local-node-health.sh

codex-schema-check:
	@test "$$($(CODEX_BIN) --version)" = "codex-cli $(CODEX_VERSION)" || (echo "expected codex-cli $(CODEX_VERSION)" >&2; exit 1)
	@schema_tmp=$$(mktemp -d); \
	trap 'rm -rf "$$schema_tmp"' EXIT; \
	$(CODEX_BIN) app-server generate-json-schema --out "$$schema_tmp"; \
	diff -ru --exclude='codex_app_server_protocol*.schemas.json' api/providers/codex/$(CODEX_VERSION) "$$schema_tmp"; \
	jq -S . api/providers/codex/$(CODEX_VERSION)/codex_app_server_protocol.schemas.json > "$$schema_tmp/expected-v1.json"; \
	jq -S . "$$schema_tmp/codex_app_server_protocol.schemas.json" > "$$schema_tmp/actual-v1.json"; \
	diff -u "$$schema_tmp/expected-v1.json" "$$schema_tmp/actual-v1.json"; \
	jq -S . api/providers/codex/$(CODEX_VERSION)/codex_app_server_protocol.v2.schemas.json > "$$schema_tmp/expected-v2.json"; \
	jq -S . "$$schema_tmp/codex_app_server_protocol.v2.schemas.json" > "$$schema_tmp/actual-v2.json"; \
	diff -u "$$schema_tmp/expected-v2.json" "$$schema_tmp/actual-v2.json"

plugin-backend-test:
	cd grafana-plugin && go test ./pkg/... && go vet ./pkg/...

plugin-backend-build:
	cd grafana-plugin && go run github.com/magefile/mage@$(MAGE_VERSION) -v buildAll

plugin-typecheck:
	npm --prefix grafana-plugin run typecheck

plugin-lint:
	npm --prefix grafana-plugin run lint

plugin-test:
	npm --prefix grafana-plugin run test:ci

plugin-build:
	npm --prefix grafana-plugin run build
