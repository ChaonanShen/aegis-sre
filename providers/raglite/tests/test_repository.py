from __future__ import annotations

from pathlib import Path

import pytest

from aegis_raglite_provider.models import Collection, Document
from aegis_raglite_provider.repository import ConflictError, NotFoundError, Repository


def new_repository(tmp_path: Path) -> Repository:
    return Repository(tmp_path / "provider.sqlite")


def collection(scope: str = "scope-a") -> Collection:
    return Collection(id="kbs_abcdefgh", name="Operations", folder_uid="folder-a", scope=scope)


def document() -> Document:
    return Document(
        id="doc_abcdefgh",
        collection_id="kbs_abcdefgh",
        name="runbook.md",
        media_type="text/markdown",
        size=10,
        sha256="a" * 64,
        original_path="originals/kbs_abcdefgh/doc_abcdefgh/runbook.md",
        service="checkout",
        tags=("prod", "runbook"),
    )


def test_collection_queries_are_scope_and_folder_bound(tmp_path: Path) -> None:
    repository = new_repository(tmp_path)
    repository.create_collection(collection())

    assert [item.id for item in repository.list_collections("scope-a", "folder-a")] == [
        "kbs_abcdefgh"
    ]
    assert repository.list_collections("scope-b", "folder-a") == []
    assert repository.list_collections("scope-a", "folder-b") == []
    with pytest.raises(NotFoundError):
        repository.get_collection("kbs_abcdefgh", "scope-b")


def test_collection_name_is_unique_only_inside_scope_and_folder(tmp_path: Path) -> None:
    repository = new_repository(tmp_path)
    repository.create_collection(collection())
    with pytest.raises(ConflictError):
        repository.create_collection(
            Collection(
                id="kbs_other000",
                name="Operations",
                folder_uid="folder-a",
                scope="scope-a",
            )
        )
    repository.create_collection(
        Collection(id="kbs_other001", name="Operations", folder_uid="folder-a", scope="scope-b")
    )


def test_collection_scope_migration_is_atomic_for_collection_and_documents(tmp_path: Path) -> None:
    repository = new_repository(tmp_path)
    repository.create_collection(collection("scp_legacy"))
    repository.create_document(document(), "scp_legacy")

    migrated = repository.migrate_collection_scope(
        "kbs_abcdefgh", "scp_legacy", "scp_folder"
    )

    assert migrated.scope == "scp_folder"
    assert repository.get_document("doc_abcdefgh", "scp_folder").id == "doc_abcdefgh"
    with pytest.raises(NotFoundError):
        repository.get_collection("kbs_abcdefgh", "scp_legacy")


def test_document_cannot_cross_collection_scope(tmp_path: Path) -> None:
    repository = new_repository(tmp_path)
    repository.create_collection(collection())
    with pytest.raises(NotFoundError):
        repository.create_document(document(), "scope-b")

    repository.create_document(document(), "scope-a")
    assert repository.get_document("doc_abcdefgh", "scope-a").tags == ("prod", "runbook")
    with pytest.raises(NotFoundError):
        repository.get_document("doc_abcdefgh", "scope-b")


def test_nonempty_collection_cannot_be_deleted(tmp_path: Path) -> None:
    repository = new_repository(tmp_path)
    repository.create_collection(collection())
    repository.create_document(document(), "scope-a")

    with pytest.raises(ConflictError):
        repository.delete_collection("kbs_abcdefgh", "scope-a")

    repository.delete_document_record("doc_abcdefgh")
    repository.delete_collection("kbs_abcdefgh", "scope-a")
    assert repository.list_collections("scope-a", "folder-a") == []


def test_job_claim_cancel_and_restart_recovery(tmp_path: Path) -> None:
    repository = new_repository(tmp_path)
    repository.create_collection(collection())
    repository.create_document(document(), "scope-a")

    repository.create_job("doc_abcdefgh", "index")
    with pytest.raises(ConflictError):
        repository.create_job("doc_abcdefgh", "index")
    assert repository.cancel_queued_job("doc_abcdefgh")
    assert repository.get_active_job("doc_abcdefgh") is None

    second = repository.create_job("doc_abcdefgh", "index")
    claimed = repository.claim_next_job()
    assert claimed is not None
    assert claimed.id == second.id
    assert claimed.status == "running"
    assert claimed.attempts == 1
    assert not repository.cancel_queued_job("doc_abcdefgh")

    assert repository.recover_running_jobs() == 1
    recovered = repository.claim_next_job()
    assert recovered is not None
    assert recovered.id == second.id
    assert recovered.attempts == 2
    assert recovered.operation == "reindex"
    repository.complete_job(recovered.id)
    assert repository.get_active_job("doc_abcdefgh") is None
