from __future__ import annotations

import io
from pathlib import Path

import pytest
from fakes import FakeBackend

from aegis_raglite_provider.original_store import OriginalStore
from aegis_raglite_provider.repository import Repository
from aegis_raglite_provider.service import CapabilityError, KnowledgeService


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
    job = service.start_indexing("doc_abcdefgh", "scope-a")

    assert service.run_once()
    document = service.get_document("doc_abcdefgh", "scope-a")
    assert document.status == "ready"
    assert backend.indexed[0][0].read_text() == "# Checkout\nrestart deployment"
    assert service.repository.get_job(job.id).status == "completed"


def test_worker_records_failure_without_losing_original(tmp_path: Path) -> None:
    service, backend = new_service(tmp_path)
    backend.fail_index = True
    job = service.start_indexing("doc_abcdefgh", "scope-a")

    assert service.run_once()
    document, content = service.open_document("doc_abcdefgh", "scope-a")
    with content:
        assert content.read().startswith(b"# Checkout")
    assert document.status == "failed"
    assert "embedding failed" in document.failure_reason
    assert service.repository.get_job(job.id).status == "failed"


def test_search_forces_scope_collection_and_service_filters(tmp_path: Path) -> None:
    service, backend = new_service(tmp_path)
    service.start_indexing("doc_abcdefgh", "scope-a")
    service.run_once()

    hits = service.search(
        query="restart",
        collection_ids=["kbs_abcdefgh"],
        scope="scope-a",
        service="checkout",
        limit=5,
        threshold=0,
    )

    assert len(hits) == 1
    assert backend.search_calls == [
        {
            "query": "restart",
            "collection_ids": ["kbs_abcdefgh"],
            "scope": "scope-a",
            "service": "checkout",
            "limit": 5,
        }
    ]


def test_search_rejects_nonzero_hybrid_threshold(tmp_path: Path) -> None:
    service, _ = new_service(tmp_path)
    with pytest.raises(CapabilityError):
        service.search(
            query="restart",
            collection_ids=["kbs_abcdefgh"],
            scope="scope-a",
            service="",
            limit=5,
            threshold=0.2,
        )


def test_stop_only_cancels_queued_job(tmp_path: Path) -> None:
    service, _ = new_service(tmp_path)
    service.start_indexing("doc_abcdefgh", "scope-a")
    service.stop_indexing("doc_abcdefgh", "scope-a")
    assert service.get_document("doc_abcdefgh", "scope-a").status == "pending"

    service.start_indexing("doc_abcdefgh", "scope-a")
    assert service.repository.claim_next_job() is not None
    with pytest.raises(CapabilityError):
        service.stop_indexing("doc_abcdefgh", "scope-a")
