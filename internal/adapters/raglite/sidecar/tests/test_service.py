from __future__ import annotations

import io
from pathlib import Path

import pytest
from fakes import FakeBackend

from aegis_raglite_sidecar.backend import Chunk
from aegis_raglite_sidecar.original_store import OriginalStore
from aegis_raglite_sidecar.repository import ConflictError, NotFoundError, Repository
from aegis_raglite_sidecar.service import CapabilityError, KnowledgeService, ValidationError


def new_service(tmp_path: Path) -> tuple[KnowledgeService, FakeBackend]:
    backend = FakeBackend()
    service = KnowledgeService(
        Repository(tmp_path / "provider.sqlite"),
        OriginalStore(tmp_path, max_bytes=1024),
        backend,
    )
    service.create_collection(
        collection_id="kbs_abcdefgh",
        name="Operations",
        folder_uid="folder-a",
        scope="scope-a",
    )
    service.upload_document(
        collection_id="kbs_abcdefgh",
        document_id="doc_abcdefgh",
        scope="scope-a",
        filename="runbook.md",
        media_type="text/markdown",
        service="checkout",
        tags=("prod",),
        content=io.BytesIO(b"# Checkout\nrestart deployment"),
    )
    return service, backend


def test_worker_indexes_original_and_marks_document_ready(tmp_path: Path) -> None:
    service, backend = new_service(tmp_path)
    job = service.repository.get_active_job("doc_abcdefgh")

    assert job is not None
    assert service.run_once()
    document = service.get_document("doc_abcdefgh", "scope-a")
    assert document.status == "ready"
    assert backend.indexed[0][0].read_text() == "# Checkout\nrestart deployment"
    assert service.repository.get_job(job.id).status == "completed"


def test_worker_records_failure_without_losing_original(tmp_path: Path) -> None:
    service, backend = new_service(tmp_path)
    backend.fail_index = True
    job = service.repository.get_active_job("doc_abcdefgh")

    assert job is not None
    assert service.run_once()
    document, content = service.open_document("doc_abcdefgh", "scope-a")
    with content:
        assert content.read().startswith(b"# Checkout")
    assert document.status == "failed"
    assert "embedding failed" in document.failure_reason
    assert service.repository.get_job(job.id).status == "failed"


def test_search_forces_scope_collection_and_service_filters(tmp_path: Path) -> None:
    service, backend = new_service(tmp_path)
    service.run_once()

    hits = service.search(
        query="restart",
        collection_ids=["kbs_abcdefgh"],
        scope="scope-a",
        service="checkout",
        tags_any=("prod",),
        tags_all=("prod",),
        limit=5,
    )

    assert len(hits) == 1
    assert hits[0].chunk.collection_id == "kbs_abcdefgh"
    assert backend.search_calls == [
        {
            "query": "restart",
            "collection_ids": ["kbs_abcdefgh"],
            "document_ids": ["doc_abcdefgh"],
            "scope": "scope-a",
            "service": "checkout",
            "limit": 5,
        }
    ]


def test_search_rejects_backend_hit_from_unrequested_collection(tmp_path: Path) -> None:
    service, backend = new_service(tmp_path)
    service.run_once()
    backend.chunks["doc_abcdefgh"] = [
        Chunk(
            id="chunk-internal-1",
            document_id="doc_abcdefgh",
            collection_id="kbs_other0000",
            source_name="runbook.md",
            text="restart",
            position="0",
        )
    ]

    with pytest.raises(RuntimeError, match="outside the requested collections"):
        service.search(
            query="restart",
            collection_ids=["kbs_abcdefgh"],
            scope="scope-a",
            service="",
            tags_any=(),
            tags_all=(),
            limit=5,
        )


def test_search_excludes_documents_that_are_not_ready(tmp_path: Path) -> None:
    service, backend = new_service(tmp_path)

    assert service.search(
        query="restart",
        collection_ids=["kbs_abcdefgh"],
        scope="scope-a",
        service="",
        tags_any=(),
        tags_all=(),
        limit=5,
    ) == []
    assert backend.search_calls == []


def test_passages_hide_provider_chunk_ids(tmp_path: Path) -> None:
    service, _ = new_service(tmp_path)
    service.run_once()

    passages = service.list_passages("doc_abcdefgh", "scope-a")

    assert passages[0].ordinal == 1
    assert passages[0].text == "restart the checkout deployment"
    assert passages[0].location == "0"
    assert not hasattr(passages[0], "id")


def test_stop_only_cancels_queued_job(tmp_path: Path) -> None:
    service, _ = new_service(tmp_path)
    service.stop_indexing("doc_abcdefgh", "scope-a")
    assert service.get_document("doc_abcdefgh", "scope-a").status == "queued"

    service.start_indexing("doc_abcdefgh", "scope-a")
    assert service.repository.claim_next_job() is not None
    with pytest.raises(CapabilityError):
        service.stop_indexing("doc_abcdefgh", "scope-a")


def test_delete_document_removes_index_original_and_manifest(tmp_path: Path) -> None:
    service, backend = new_service(tmp_path)
    original = service.originals.resolve(
        service.get_document("doc_abcdefgh", "scope-a").original_path
    )

    service.delete_document("doc_abcdefgh", "scope-a")

    assert backend.deleted == ["doc_abcdefgh"]
    assert not original.exists()
    with pytest.raises(NotFoundError):
        service.get_document("doc_abcdefgh", "scope-a")


def test_delete_failure_preserves_original_and_manifest_for_retry(tmp_path: Path) -> None:
    service, backend = new_service(tmp_path)
    document = service.get_document("doc_abcdefgh", "scope-a")
    original = service.originals.resolve(document.original_path)
    backend.fail_delete = True

    with pytest.raises(RuntimeError, match="index delete failed"):
        service.delete_document("doc_abcdefgh", "scope-a")

    assert original.exists()
    assert service.get_document("doc_abcdefgh", "scope-a").id == "doc_abcdefgh"


def test_delete_collection_rejects_nonempty_collection(tmp_path: Path) -> None:
    service, backend = new_service(tmp_path)

    with pytest.raises(ConflictError, match="collection is not empty"):
        service.delete_collection("kbs_abcdefgh", "scope-a")

    assert backend.deleted == []
    assert service.get_collection("kbs_abcdefgh", "scope-a").id == "kbs_abcdefgh"


def test_upload_automatically_queues_index_job(tmp_path: Path) -> None:
    service, _ = new_service(tmp_path)

    document = service.get_document("doc_abcdefgh", "scope-a")
    job = service.repository.get_active_job(document.id)

    assert document.status == "queued"
    assert job is not None
    assert job.operation == "index"
    assert job.status == "queued"


def test_failed_document_can_retry_index_idempotently(tmp_path: Path) -> None:
    service, backend = new_service(tmp_path)
    backend.fail_index = True
    service.run_once()
    backend.fail_index = False

    retried = service.retry_indexing("doc_abcdefgh", "scope-a")
    repeated = service.retry_indexing("doc_abcdefgh", "scope-a")

    assert retried.status == "queued"
    assert repeated.status == "queued"
    assert service.repository.get_active_job("doc_abcdefgh") is not None


def test_metadata_changed_during_indexing_queues_latest_generation(tmp_path: Path) -> None:
    service, backend = new_service(tmp_path)
    first_job = service.repository.get_active_job("doc_abcdefgh")

    backend.on_index = lambda: service.update_document(
        "doc_abcdefgh", "scope-a", service="payments", tags=("approved",)
    )
    service.run_once()

    document = service.get_document("doc_abcdefgh", "scope-a")
    next_job = service.repository.get_active_job(document.id)
    assert first_job is not None
    assert service.repository.get_job(first_job.id).status == "completed"
    assert document.status == "queued"
    assert document.service == "payments"
    assert next_job is not None
    assert next_job.id != first_job.id

    backend.on_index = None
    service.run_once()
    assert service.get_document("doc_abcdefgh", "scope-a").status == "ready"
    assert backend.indexed[-1][1].service == "payments"


def test_scope_migration_requires_distinct_provider_scopes(tmp_path: Path) -> None:
    service, _ = new_service(tmp_path)
    with pytest.raises(ValidationError, match="distinct valid source and target scopes"):
        service.migrate_collection_scope("kbs_abcdefgh", "scope-a", "scope-a")
