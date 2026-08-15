# RAGFlow local deployment

`compose.knowledge.yaml` is an opt-in deployment of the Phase 8 Knowledge stack. It pins RAGFlow 0.26.4 and all dependency images by version and digest. RAGFlow, MySQL, Elasticsearch, MinIO, Valkey, and TEI are only reachable on Docker-internal networks; the browser and Agent never receive a RAGFlow credential.

## Bootstrap

1. Run `AEGIS_INIT_KNOWLEDGE_SECRETS=1 AEGIS_KNOWLEDGE_PROVIDER=ragflow scripts/init-local-secrets.sh`. The script creates the Aegis identity key, MCP caller token, and dependency passwords. It never invents a RAGFlow API key because that key must belong to an actual RAGFlow tenant.
2. Start the Knowledge dependency services and the loopback-only bootstrap UI once with `docker compose -f compose.yaml -f compose.knowledge.yaml -f compose.knowledge-bootstrap.yaml up -d ragflow`.
3. Open `http://127.0.0.1:9388` (or the loopback port selected by `RAGFLOW_BOOTSTRAP_PORT`), create the service tenant and API key, then write only the key to `deploy/local/secrets/ragflow-api-key`. Do not commit it. Remove the bootstrap override immediately afterward with `docker compose -f compose.yaml -f compose.knowledge.yaml -f compose.knowledge-bootstrap.yaml down`, then restart without that file. Registration and host ports remain disabled in steady state.
4. Start the complete stack with `docker compose -f compose.yaml -f compose.knowledge.yaml up -d --build`.
5. Restart Grafana after the Phase 8 `plugin.json` IAM changes. OpenCode performs `mcp list` before serving and fails startup if the authenticated Knowledge MCP handshake fails.

The configured embedding is `BAAI/bge-small-en-v1.5@Builtin`, served by the pinned external TEI container. This English-oriented small model is the local resource-saving default, not the production quality target. Production must configure and evaluate the chosen multilingual embedding explicitly.

## Resources and readiness

Allow at least 12 GiB RAM, 4 CPUs, and 50 GiB free disk for the local stack. The pinned TEI image alone expands to about 33 GB in Docker Desktop; RAGFlow, Elasticsearch, writable layers, and initial indexes need additional headroom. Elasticsearch is capped at a 2 GiB JVM heap, document bulk size is reduced to 2, and embedding batches to 8. RAGFlow readiness calls `/api/v1/system/healthz`; Control Plane readiness also probes RAGFlow through its adapter. Without `compose.knowledge.yaml`, the existing Grafana, Dagu, and Agent stack remains independently runnable.

## Backup and restore

Back up these named volumes as one consistency set while writes are stopped:

- `ragflow-mysql-data`: tenant configuration and RAGFlow metadata;
- `ragflow-es-data`: parsed text and vector index;
- `ragflow-minio-data`: uploaded originals and object data;
- `ragflow-valkey-data`: queue/cache state (rebuildable, but capture it with the set);
- `ragflow-logs`: diagnostic logs, not a source of truth.

Also back up `knowledge-id-key` separately in the secret manager. Losing it breaks deterministic public ID continuity. Restore the same RAGFlow version and all four data volumes before starting RAGFlow, restore the ID key and API key, then verify readiness, a known document download, and a known citation search before admitting writes. Never use `docker compose down -v` on a stack whose data must be retained.
