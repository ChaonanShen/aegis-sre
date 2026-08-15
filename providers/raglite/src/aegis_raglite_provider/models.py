"""Provider-owned resource models."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Literal

CollectionStatus = Literal["active", "disabled"]
DocumentStatus = Literal["pending", "indexing", "ready", "failed", "disabled"]
JobStatus = Literal["queued", "running", "completed", "failed", "cancelled"]
JobOperation = Literal["index", "reindex", "delete"]


def now_iso() -> str:
    return datetime.now(UTC).isoformat()


@dataclass(frozen=True)
class Collection:
    id: str
    name: str
    folder_uid: str
    scope: str
    status: CollectionStatus = "active"
    created_at: str = field(default_factory=now_iso)
    updated_at: str = field(default_factory=now_iso)


@dataclass(frozen=True)
class Document:
    id: str
    collection_id: str
    name: str
    media_type: str
    size: int
    sha256: str
    original_path: str
    service: str
    tags: tuple[str, ...]
    status: DocumentStatus = "pending"
    failure_reason: str = ""
    created_at: str = field(default_factory=now_iso)
    updated_at: str = field(default_factory=now_iso)


@dataclass(frozen=True)
class Job:
    id: str
    document_id: str
    operation: JobOperation
    status: JobStatus
    attempts: int = 0
    error: str = ""
    created_at: str = field(default_factory=now_iso)
    started_at: str | None = None
    finished_at: str | None = None
