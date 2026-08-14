# OpenCode Provider Contract

`1.18.18/openapi.json` is the OpenAPI 3.1 contract published from the pinned
`anomalyco/opencode` `v1.18.18` tag:

```text
https://raw.githubusercontent.com/anomalyco/opencode/v1.18.18/packages/sdk/openapi.json
```

SHA-256:

```text
5bbd6493a1a488ef4294889341c896e420f814ecea95822100aaa9f3f95ab2d1
```

The snapshot intentionally contains both the V2 `/api/*` surface and compatible
V1 endpoints. The Aegis adapter must select an endpoint explicitly per operation
and validate that V1 and V2 address the same provider-owned Session. Do not copy
OpenCode SDK types into `internal/domain`, `internal/ports`, or the public API.

To upgrade OpenCode, update `deploy/agents/versions.env`, replace the snapshot,
update the checksum contract test, and run the Provider contract and end-to-end
tests before merging.
