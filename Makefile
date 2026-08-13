.PHONY: verify contracts-generate contracts-check control-plane-test control-plane-build plugin-typecheck plugin-lint plugin-test plugin-build

OAPI_CODEGEN_VERSION := v2.8.0

verify: contracts-check control-plane-test control-plane-build plugin-typecheck plugin-lint plugin-test plugin-build

contracts-generate:
	go run github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@$(OAPI_CODEGEN_VERSION) --config api/oapi-codegen.yaml api/openapi.yaml
	npm --prefix grafana-plugin run contracts:generate

contracts-check: contracts-generate
	git diff --exit-code -- internal/contracts/apiv1/generated.go grafana-plugin/src/api/generated/controlPlane.ts grafana-plugin/src/api/generated/events.ts

control-plane-test:
	go test ./...

control-plane-build:
	go build ./cmd/control-plane

plugin-typecheck:
	npm --prefix grafana-plugin run typecheck

plugin-lint:
	npm --prefix grafana-plugin run lint

plugin-test:
	npm --prefix grafana-plugin run test:ci

plugin-build:
	npm --prefix grafana-plugin run build
