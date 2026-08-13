.PHONY: verify contracts-generate contracts-check contracts-go-generate contracts-go-check contracts-ts-generate contracts-ts-check control-plane-test control-plane-build plugin-backend-test plugin-backend-build plugin-typecheck plugin-lint plugin-test plugin-build

OAPI_CODEGEN_VERSION := v2.8.0
MAGE_VERSION := v1.17.2

verify: contracts-check control-plane-test control-plane-build plugin-backend-test plugin-backend-build plugin-typecheck plugin-lint plugin-test plugin-build

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
