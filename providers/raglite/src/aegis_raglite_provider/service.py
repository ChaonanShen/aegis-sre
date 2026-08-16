"""Application services and the single-writer indexing worker."""

from __future__ import annotations

import threading
from pathlib import Path
from typing import BinaryIO

from aegis_raglite_provider.backend import Backend, Chunk, SearchHit
from aegis_raglite_provider.models import Collection, Document, Job
from aegis_raglite_provider.original_store import OriginalStore
from aegis_raglite_provider.repository import ConflictError, Repository


class CapabilityError(Exception):
    pass


class ValidationError(Exception):
    pass


class KnowledgeService:
    def __init__(
        self,
        repository: Repository,
        originals: OriginalStore,
        backend: Backend,
        poll_seconds: float = 0.25,
    ) -> None:
        self.repository = repository
        self.originals = originals
        self.backend = backend
        self._poll_seconds = poll_seconds
        self._stop = threading.Event()
        self._worker: threading.Thread | None = None

    def start(self) -> None:
        self.repository.recover_running_jobs()
        if self._worker is not None:
            return
        self._worker = threading.Thread(target=self._run, name="raglite-writer", daemon=True)
        self._worker.start()

    def stop(self) -> None:
        self._stop.set()
        if self._worker is not None:
            self._worker.join(timeout=5)
            self._worker = None

    def check(self) -> None:
        self.backend.check()

    def create_collection(
        self, *, collection_id: str, name: str, folder_uid: str, scope: str
    ) -> Collection:
        self._validate_id(collection_id, "kbs_")
        if not name.strip() or not folder_uid.strip() or not scope.strip():
            raise ValidationError("name, folder_uid and scope are required")
        return self.repository.create_collection(
            Collection(
                id=collection_id,
                name=name.strip(),
                folder_uid=folder_uid.strip(),
                scope=scope,
            )
        )

    def list_collections(self, scope: str, folder_uid: str) -> list[Collection]:
        return self.repository.list_collections(scope, folder_uid)

    def inventory_collections(self) -> list[Collection]:
        return self.repository.inventory_collections()

    def get_collection(self, collection_id: str, scope: str) -> Collection:
        return self.repository.get_collection(collection_id, scope)

    def update_collection(
        self, collection_id: str, scope: str, *, name: str, status: str
    ) -> Collection:
        if status not in {"active", "disabled"} or not name.strip():
            raise ValidationError("valid name and status are required")
        return self.repository.update_collection(
            collection_id, scope, name=name.strip(), status=status
        )

    def migrate_collection_scope(
        self, collection_id: str, source_scope: str, target_scope: str
    ) -> Collection:
        self._validate_id(collection_id, "kbs_")
        if (
            not source_scope.startswith("scp_")
            or not target_scope.startswith("scp_")
            or source_scope == target_scope
        ):
            raise ValidationError("distinct valid source and target scopes are required")
        return self.repository.migrate_collection_scope(
            collection_id, source_scope, target_scope
        )

    def delete_collection(self, collection_id: str, scope: str) -> None:
        # 首版不做隐式级联，避免一次管理操作同时删除原文和索引。
        self.repository.delete_collection(collection_id, scope)

    def upload_document(
        self,
        *,
        collection_id: str,
        document_id: str,
        scope: str,
        filename: str,
        media_type: str,
        service: str,
        tags: tuple[str, ...],
        content: BinaryIO,
    ) -> Document:
        self._validate_id(document_id, "doc_")
        self.repository.get_collection(collection_id, scope)
        try:
            relative, size, digest = self.originals.save(
                collection_id, document_id, filename, content
            )
        except FileExistsError as error:
            raise ConflictError("document already exists") from error
        document = Document(
            id=document_id,
            collection_id=collection_id,
            name=Path(filename).name,
            media_type=media_type or "application/octet-stream",
            size=size,
            sha256=digest,
            original_path=relative,
            service=service.strip(),
            tags=self._normalize_tags(tags),
        )
        try:
            queued, _ = self.repository.create_queued_document(document, scope)
            return queued
        except Exception:
            self.originals.delete(relative)
            raise

    def list_documents(self, collection_id: str, scope: str) -> list[Document]:
        return self.repository.list_documents(collection_id, scope)

    def get_document(self, document_id: str, scope: str) -> Document:
        return self.repository.get_document(document_id, scope)

    def update_document(
        self,
        document_id: str,
        scope: str,
        *,
        service: str,
        tags: tuple[str, ...],
    ) -> Document:
        previous = self.repository.get_document(document_id, scope)
        document = self.repository.update_document_metadata(
            document_id,
            scope,
            service=service.strip(),
            tags=self._normalize_tags(tags),
        )
        if previous.status in {"ready", "failed"}:
            self.repository.create_job(document_id, "reindex")
        return document

    def start_indexing(self, document_id: str, scope: str) -> Job:
        document = self.repository.get_document(document_id, scope)
        active = self.repository.get_active_job(document_id)
        if active is not None:
            return active
        job = self.repository.create_job(
            document_id, "reindex" if document.status in {"ready", "failed"} else "index"
        )
        self.repository.set_document_status(document_id, "queued")
        return job

    def retry_indexing(self, document_id: str, scope: str) -> Document:
        document = self.repository.get_document(document_id, scope)
        if document.status != "failed":
            return document
        self.repository.create_job(document_id, "reindex")
        return self.repository.set_document_status(document_id, "queued")

    def stop_indexing(self, document_id: str, scope: str) -> None:
        self.repository.get_document(document_id, scope)
        active = self.repository.get_active_job(document_id)
        if active is None:
            raise ConflictError("document has no active indexing job")
        if active.status == "running":
            raise CapabilityError("running indexing cannot be cancelled safely")
        if not self.repository.cancel_queued_job(document_id):
            raise ConflictError("indexing job state changed")
        self.repository.set_document_status(document_id, "queued")

    def delete_document(self, document_id: str, scope: str) -> None:
        document = self.repository.get_document(document_id, scope)
        active = self.repository.get_active_job(document_id)
        if active is not None and active.status == "running":
            raise ConflictError("document is indexing")
        if active is not None and not self.repository.cancel_queued_job(document_id):
            raise ConflictError("indexing job state changed")
        self.backend.delete(document.id)
        self.originals.delete(document.original_path)
        self.repository.delete_document_record(document.id)

    def list_chunks(self, document_id: str, scope: str) -> list[Chunk]:
        self.repository.get_document(document_id, scope)
        return self.backend.list_chunks(document_id)

    def open_document(self, document_id: str, scope: str) -> tuple[Document, BinaryIO]:
        document = self.repository.get_document(document_id, scope)
        return document, self.originals.open(document.original_path)

    def get_job(self, job_id: str, scope: str) -> Job:
        job = self.repository.get_job(job_id)
        self.repository.get_document(job.document_id, scope)
        return job

    def search(
        self,
        *,
        query: str,
        collection_ids: list[str],
        scope: str,
        service: str,
        limit: int,
        threshold: float,
    ) -> list[SearchHit]:
        if not query.strip() or not collection_ids or limit < 1 or limit > 100:
            raise ValidationError("query, collections and limit are required")
        if threshold != 0:
            raise CapabilityError("hybrid retrieval does not support similarity threshold")
        for collection_id in collection_ids:
            self.repository.get_collection(collection_id, scope)
        hits = self.backend.search(
            query.strip(),
            collection_ids=collection_ids,
            scope=scope,
            service=service.strip(),
            limit=limit,
        )
        allowed_collections = set(collection_ids)
        if any(hit.chunk.collection_id not in allowed_collections for hit in hits):
            raise RuntimeError("backend returned a chunk outside the requested collections")
        return hits

    def run_once(self) -> bool:
        job = self.repository.claim_next_job()
        if job is None:
            return False
        try:
            document, collection = self.repository.get_document_context(job.document_id)
            self.repository.set_document_status(document.id, "indexing")
            if job.operation == "reindex":
                self.backend.delete(document.id)
            self.backend.index(self.originals.resolve(document.original_path), document, collection)
            if not self.backend.list_chunks(document.id):
                raise RuntimeError("RAGLite returned no chunks after indexing")
            self.repository.set_document_status(document.id, "ready")
            self.repository.complete_job(job.id)
        except Exception as error:
            self.repository.set_document_status(job.document_id, "failed", str(error)[:1000])
            self.repository.fail_job(job.id, str(error))
        return True

    def _run(self) -> None:
        while not self._stop.is_set():
            if not self.run_once():
                self._stop.wait(self._poll_seconds)

    @staticmethod
    def _validate_id(value: str, prefix: str) -> None:
        if not value.startswith(prefix) or len(value) < len(prefix) + 8:
            raise ValidationError(f"valid {prefix.rstrip('_')} ID is required")

    @staticmethod
    def _normalize_tags(tags: tuple[str, ...]) -> tuple[str, ...]:
        normalized = tuple(dict.fromkeys(tag.strip() for tag in tags if tag.strip()))
        if len(normalized) > 32 or any(len(tag) > 64 for tag in normalized):
            raise ValidationError("tags exceed configured limits")
        return normalized
