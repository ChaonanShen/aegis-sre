.PHONY: verify control-plane-test control-plane-build plugin-typecheck plugin-lint plugin-test plugin-build

verify: control-plane-test control-plane-build plugin-typecheck plugin-lint plugin-test plugin-build

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
