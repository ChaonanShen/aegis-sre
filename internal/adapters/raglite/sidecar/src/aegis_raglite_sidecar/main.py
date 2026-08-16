"""Production application entrypoint."""

from aegis_raglite_sidecar.api import create_app
from aegis_raglite_sidecar.backend import RAGLiteBackend
from aegis_raglite_sidecar.config import Config, TokenSource
from aegis_raglite_sidecar.original_store import OriginalStore
from aegis_raglite_sidecar.repository import Repository
from aegis_raglite_sidecar.service import KnowledgeService

config = Config.from_env()
repository = Repository(config.data_dir / "provider.sqlite")
originals = OriginalStore(config.data_dir, config.max_upload_bytes)
backend = RAGLiteBackend(config.data_dir / "raglite.db", config.embedder)
service = KnowledgeService(
    repository,
    originals,
    backend,
    poll_seconds=config.worker_poll_seconds,
)
app = create_app(service, TokenSource(config.token_file), manage_worker=True)
