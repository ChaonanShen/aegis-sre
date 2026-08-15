"""SQLite manifest for Provider-owned lifecycle state."""

from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from dataclasses import replace
from pathlib import Path

from aegis_raglite_provider.models import Collection, Document, Job, now_iso


class ConflictError(Exception):
    pass


class NotFoundError(Exception):
    pass


class Repository:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._path = path
        self._lock = threading.RLock()
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self._path, timeout=30)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS collections (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    folder_uid TEXT NOT NULL,
                    scope TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(scope, folder_uid, name)
                );
                CREATE INDEX IF NOT EXISTS collections_scope_idx
                    ON collections(scope, folder_uid);

                CREATE TABLE IF NOT EXISTS documents (
                    id TEXT PRIMARY KEY,
                    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE RESTRICT,
                    name TEXT NOT NULL,
                    media_type TEXT NOT NULL,
                    size INTEGER NOT NULL CHECK (size >= 0),
                    sha256 TEXT NOT NULL,
                    original_path TEXT NOT NULL,
                    service TEXT NOT NULL,
                    tags TEXT NOT NULL,
                    status TEXT NOT NULL CHECK (
                        status IN ('pending', 'indexing', 'ready', 'failed', 'disabled')
                    ),
                    failure_reason TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    UNIQUE(collection_id, id)
                );
                CREATE INDEX IF NOT EXISTS documents_collection_idx
                    ON documents(collection_id, created_at);

                CREATE TABLE IF NOT EXISTS jobs (
                    id TEXT PRIMARY KEY,
                    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
                    operation TEXT NOT NULL CHECK (operation IN ('index', 'reindex', 'delete')),
                    status TEXT NOT NULL CHECK (
                        status IN ('queued', 'running', 'completed', 'failed', 'cancelled')
                    ),
                    attempts INTEGER NOT NULL,
                    error TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    started_at TEXT,
                    finished_at TEXT
                );
                CREATE INDEX IF NOT EXISTS jobs_queue_idx ON jobs(status, created_at);
                """
            )

    def create_collection(self, collection: Collection) -> Collection:
        with self._lock, self._connect() as connection:
            try:
                connection.execute(
                    """INSERT INTO collections
                       (id, name, folder_uid, scope, status, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    (
                        collection.id,
                        collection.name,
                        collection.folder_uid,
                        collection.scope,
                        collection.status,
                        collection.created_at,
                        collection.updated_at,
                    ),
                )
            except sqlite3.IntegrityError as error:
                raise ConflictError("collection already exists") from error
        return collection

    def list_collections(self, scope: str, folder_uid: str) -> list[Collection]:
        with self._connect() as connection:
            rows = connection.execute(
                """SELECT * FROM collections
                   WHERE scope = ? AND folder_uid = ? ORDER BY created_at, id""",
                (scope, folder_uid),
            ).fetchall()
        return [self._collection(row) for row in rows]

    def get_collection(self, collection_id: str, scope: str) -> Collection:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM collections WHERE id = ? AND scope = ?",
                (collection_id, scope),
            ).fetchone()
        if row is None:
            raise NotFoundError("collection not found")
        return self._collection(row)

    def update_collection(
        self, collection_id: str, scope: str, *, name: str, status: str
    ) -> Collection:
        timestamp = now_iso()
        with self._lock, self._connect() as connection:
            cursor = connection.execute(
                """UPDATE collections SET name = ?, status = ?, updated_at = ?
                   WHERE id = ? AND scope = ?""",
                (name, status, timestamp, collection_id, scope),
            )
            if cursor.rowcount != 1:
                raise NotFoundError("collection not found")
        return self.get_collection(collection_id, scope)

    def delete_collection(self, collection_id: str, scope: str) -> None:
        with self._lock, self._connect() as connection:
            try:
                cursor = connection.execute(
                    "DELETE FROM collections WHERE id = ? AND scope = ?",
                    (collection_id, scope),
                )
            except sqlite3.IntegrityError as error:
                raise ConflictError("collection is not empty") from error
            if cursor.rowcount != 1:
                raise NotFoundError("collection not found")

    def create_document(self, document: Document, scope: str) -> Document:
        self.get_collection(document.collection_id, scope)
        with self._lock, self._connect() as connection:
            try:
                connection.execute(
                    """INSERT INTO documents
                       (id, collection_id, name, media_type, size, sha256, original_path,
                        service, tags, status, failure_reason, created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        document.id,
                        document.collection_id,
                        document.name,
                        document.media_type,
                        document.size,
                        document.sha256,
                        document.original_path,
                        document.service,
                        json.dumps(document.tags),
                        document.status,
                        document.failure_reason,
                        document.created_at,
                        document.updated_at,
                    ),
                )
            except sqlite3.IntegrityError as error:
                raise ConflictError("document already exists") from error
        return document

    def list_documents(self, collection_id: str, scope: str) -> list[Document]:
        self.get_collection(collection_id, scope)
        with self._connect() as connection:
            rows = connection.execute(
                """SELECT d.* FROM documents d
                   JOIN collections c ON c.id = d.collection_id
                   WHERE d.collection_id = ? AND c.scope = ?
                   ORDER BY d.created_at, d.id""",
                (collection_id, scope),
            ).fetchall()
        return [self._document(row) for row in rows]

    def get_document(self, document_id: str, scope: str) -> Document:
        with self._connect() as connection:
            row = connection.execute(
                """SELECT d.* FROM documents d
                   JOIN collections c ON c.id = d.collection_id
                   WHERE d.id = ? AND c.scope = ?""",
                (document_id, scope),
            ).fetchone()
        if row is None:
            raise NotFoundError("document not found")
        return self._document(row)

    def get_document_context(self, document_id: str) -> tuple[Document, Collection]:
        with self._connect() as connection:
            row = connection.execute(
                """SELECT d.*, c.id AS c_id, c.name AS c_name,
                          c.folder_uid AS c_folder_uid, c.scope AS c_scope,
                          c.status AS c_status, c.created_at AS c_created_at,
                          c.updated_at AS c_updated_at
                   FROM documents d JOIN collections c ON c.id = d.collection_id
                   WHERE d.id = ?""",
                (document_id,),
            ).fetchone()
        if row is None:
            raise NotFoundError("document not found")
        collection = Collection(
            id=row["c_id"],
            name=row["c_name"],
            folder_uid=row["c_folder_uid"],
            scope=row["c_scope"],
            status=row["c_status"],
            created_at=row["c_created_at"],
            updated_at=row["c_updated_at"],
        )
        return self._document(row), collection

    def update_document_metadata(
        self, document_id: str, scope: str, *, service: str, tags: tuple[str, ...]
    ) -> Document:
        self.get_document(document_id, scope)
        with self._lock, self._connect() as connection:
            connection.execute(
                """UPDATE documents
                   SET service = ?, tags = ?, status = 'pending', failure_reason = '',
                       updated_at = ?
                   WHERE id = ?""",
                (service, json.dumps(tags), now_iso(), document_id),
            )
        return self.get_document(document_id, scope)

    def set_document_status(
        self, document_id: str, status: str, failure_reason: str = ""
    ) -> Document:
        with self._lock, self._connect() as connection:
            cursor = connection.execute(
                """UPDATE documents SET status = ?, failure_reason = ?, updated_at = ?
                   WHERE id = ?""",
                (status, failure_reason, now_iso(), document_id),
            )
            if cursor.rowcount != 1:
                raise NotFoundError("document not found")
            row = connection.execute(
                """SELECT d.*, c.scope FROM documents d
                   JOIN collections c ON c.id = d.collection_id WHERE d.id = ?""",
                (document_id,),
            ).fetchone()
        return self._document(row)

    def delete_document_record(self, document_id: str) -> None:
        with self._lock, self._connect() as connection:
            cursor = connection.execute("DELETE FROM documents WHERE id = ?", (document_id,))
            if cursor.rowcount != 1:
                raise NotFoundError("document not found")

    def create_job(self, document_id: str, operation: str) -> Job:
        job = Job(
            id=f"job_{uuid.uuid4().hex}",
            document_id=document_id,
            operation=operation,
            status="queued",
        )
        with self._lock, self._connect() as connection:
            active = connection.execute(
                """SELECT id FROM jobs
                   WHERE document_id = ? AND status IN ('queued', 'running')""",
                (document_id,),
            ).fetchone()
            if active is not None:
                raise ConflictError("document already has an active job")
            connection.execute(
                """INSERT INTO jobs
                   (id, document_id, operation, status, attempts, error, created_at,
                    started_at, finished_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    job.id,
                    job.document_id,
                    job.operation,
                    job.status,
                    job.attempts,
                    job.error,
                    job.created_at,
                    job.started_at,
                    job.finished_at,
                ),
            )
        return job

    def claim_next_job(self) -> Job | None:
        # BEGIN IMMEDIATE 保证多个线程不会领取同一个写任务。
        with self._lock, self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at, id LIMIT 1"
            ).fetchone()
            if row is None:
                connection.commit()
                return None
            started_at = now_iso()
            connection.execute(
                """UPDATE jobs
                   SET status = 'running', attempts = attempts + 1, started_at = ?
                   WHERE id = ? AND status = 'queued'""",
                (started_at, row["id"]),
            )
            connection.commit()
            return replace(
                self._job(row),
                status="running",
                attempts=int(row["attempts"]) + 1,
                started_at=started_at,
            )

    def complete_job(self, job_id: str) -> None:
        self._finish_job(job_id, "completed", "")

    def fail_job(self, job_id: str, error: str) -> None:
        self._finish_job(job_id, "failed", error[:2000])

    def cancel_queued_job(self, document_id: str) -> bool:
        with self._lock, self._connect() as connection:
            cursor = connection.execute(
                """UPDATE jobs SET status = 'cancelled', finished_at = ?
                   WHERE document_id = ? AND status = 'queued'""",
                (now_iso(), document_id),
            )
        return cursor.rowcount == 1

    def get_active_job(self, document_id: str) -> Job | None:
        with self._connect() as connection:
            row = connection.execute(
                """SELECT * FROM jobs WHERE document_id = ?
                   AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1""",
                (document_id,),
            ).fetchone()
        return self._job(row) if row else None

    def get_job(self, job_id: str) -> Job:
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
        if row is None:
            raise NotFoundError("job not found")
        return self._job(row)

    def recover_running_jobs(self) -> int:
        # 进程可能在 DuckDB 提交中退出，恢复时重新排队并由 worker 对账后重建。
        with self._lock, self._connect() as connection:
            cursor = connection.execute(
                """UPDATE jobs SET status = 'queued', error = 'recovered after restart',
                   operation = CASE WHEN operation = 'index' THEN 'reindex' ELSE operation END,
                   started_at = NULL WHERE status = 'running'"""
            )
        return cursor.rowcount

    def _finish_job(self, job_id: str, status: str, error: str) -> None:
        with self._lock, self._connect() as connection:
            cursor = connection.execute(
                """UPDATE jobs SET status = ?, error = ?, finished_at = ?
                   WHERE id = ? AND status = 'running'""",
                (status, error, now_iso(), job_id),
            )
            if cursor.rowcount != 1:
                raise ConflictError("job is not running")

    @staticmethod
    def _collection(row: sqlite3.Row) -> Collection:
        return Collection(
            id=row["id"],
            name=row["name"],
            folder_uid=row["folder_uid"],
            scope=row["scope"],
            status=row["status"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    @staticmethod
    def _document(row: sqlite3.Row) -> Document:
        return Document(
            id=row["id"],
            collection_id=row["collection_id"],
            name=row["name"],
            media_type=row["media_type"],
            size=row["size"],
            sha256=row["sha256"],
            original_path=row["original_path"],
            service=row["service"],
            tags=tuple(json.loads(row["tags"])),
            status=row["status"],
            failure_reason=row["failure_reason"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    @staticmethod
    def _job(row: sqlite3.Row) -> Job:
        return Job(
            id=row["id"],
            document_id=row["document_id"],
            operation=row["operation"],
            status=row["status"],
            attempts=row["attempts"],
            error=row["error"],
            created_at=row["created_at"],
            started_at=row["started_at"],
            finished_at=row["finished_at"],
        )
