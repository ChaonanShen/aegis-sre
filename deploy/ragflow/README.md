# RAGFlow local deployment

> 退出窗口归档：当前 Control Plane 已固定装配 RAGLite，本目录和根目录 `compose.knowledge.yaml` 只用于历史
> 数据识别、归档和匹配旧发布版本的受控回退，不能直接接到当前版本。不要与
> `deploy/raglite/compose.yaml` 同时启动或写入。物理删除仍需完成作者确认、数据盘点和 1～2 个发布周期门禁。

`compose.knowledge.yaml` is an opt-in deployment of the Phase 8 Knowledge stack. It pins RAGFlow 0.26.4 and all dependency images by version and digest. RAGFlow, MySQL, Elasticsearch, MinIO, Valkey, and TEI are only reachable on Docker-internal networks; the browser and Agent never receive a RAGFlow credential.

## Historical bootstrap

The current `scripts/init-local-secrets.sh` intentionally creates only RAGLite Knowledge secrets, and the current Control
Plane no longer reads RAGFlow configuration. If an approved rollback is required, check out the recorded pre-ADR release and
follow that release's README and secret initialization process. Never try to make this archived Compose file work by adding
RAGFlow credentials to the current Control Plane.

The configured embedding is `BAAI/bge-small-en-v1.5@Builtin`, served by the pinned external TEI container. This English-oriented small model is the local resource-saving default, not the production quality target. Production must configure and evaluate the chosen multilingual embedding explicitly.

## Resources and readiness

The historical stack required at least 12 GiB RAM, 4 CPUs, and 50 GiB free disk. The pinned TEI image alone expands to about 33 GB in Docker Desktop; RAGFlow, Elasticsearch, writable layers, and initial indexes need additional headroom. These figures are retained for migration and recovery planning, not as instructions to start the archived stack with the current release.

## Backup and restore

Back up these named volumes as one consistency set while writes are stopped:

- `ragflow-mysql-data`: tenant configuration and RAGFlow metadata;
- `ragflow-es-data`: parsed text and vector index;
- `ragflow-minio-data`: uploaded originals and object data;
- `ragflow-valkey-data`: queue/cache state (rebuildable, but capture it with the set);
- `ragflow-logs`: diagnostic logs, not a source of truth.

Also back up `knowledge-id-key` separately in the secret manager. Losing it breaks deterministic public ID continuity. Restore the same RAGFlow version and all four data volumes before starting RAGFlow, restore the ID key and API key, then verify readiness, a known document download, and a known citation search before admitting writes. Never use `docker compose down -v` on a stack whose data must be retained.
