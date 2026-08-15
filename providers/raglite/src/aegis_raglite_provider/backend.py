"""RAGLite facade. Provider-private imports stay in this module."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from aegis_raglite_provider.models import Collection, Document


@dataclass(frozen=True)
class Chunk:
    id: str
    document_id: str
    collection_id: str
    source_name: str
    text: str
    position: str
    page_number: int = 0


@dataclass(frozen=True)
class SearchHit:
    chunk: Chunk
    score: float


class Backend(Protocol):
    def check(self) -> None: ...
    def index(self, path: Path, document: Document, collection: Collection) -> None: ...
    def delete(self, document_id: str) -> None: ...
    def list_chunks(self, document_id: str) -> list[Chunk]: ...
    def search(
        self,
        query: str,
        *,
        collection_ids: list[str],
        scope: str,
        service: str,
        limit: int,
    ) -> list[SearchHit]: ...


class RAGLiteBackend:
    def __init__(self, database_path: Path, embedder: str) -> None:
        database_path.parent.mkdir(parents=True, exist_ok=True)
        self._database_path = database_path
        self._embedder = embedder
        self._config_instance = None

    def _config(self):
        if self._config_instance is None:
            from raglite import RAGLiteConfig

            self._config_instance = RAGLiteConfig(
                db_url=f"duckdb:///{self._database_path.as_posix()}",
                embedder=self._embedder,
                reranker=None,
                vector_search_query_adapter=False,
            )
        return self._config_instance

    def check(self) -> None:
        from raglite._database import create_database_engine
        from sqlalchemy import text

        with create_database_engine(self._config()).connect() as connection:
            connection.execute(text("SELECT 1"))

    def index(self, path: Path, document: Document, collection: Collection) -> None:
        from raglite import Document as RAGDocument
        from raglite import insert_documents

        rag_document = RAGDocument.from_path(
            path,
            id=document.id,
            config=self._config(),
            aegis_collection_id=collection.id,
            aegis_document_id=document.id,
            aegis_scope=collection.scope,
            aegis_service=document.service,
            aegis_tags=list(document.tags),
        )
        insert_documents([rag_document], max_workers=1, config=self._config())

    def delete(self, document_id: str) -> None:
        from raglite import delete_documents

        delete_documents([document_id], config=self._config())

    def list_chunks(self, document_id: str) -> list[Chunk]:
        # RAGLite 1.1.1 没有按 Document 列出 Chunk 的公共函数；固定版本内集中封装私有查询。
        from raglite._database import Chunk as RAGChunk
        from raglite._database import create_database_engine
        from sqlalchemy.orm import joinedload
        from sqlmodel import Session, col, select

        with Session(create_database_engine(self._config())) as session:
            chunks = list(
                session.exec(
                    select(RAGChunk)
                    .where(RAGChunk.document_id == document_id)
                    .order_by(col(RAGChunk.index))
                    .options(joinedload(RAGChunk.document))
                ).all()
            )
        return [
            Chunk(
                id=str(chunk.id),
                document_id=str(chunk.document_id),
                collection_id=_required_metadata_string(
                    chunk.document.metadata_, "aegis_collection_id"
                ),
                source_name=chunk.document.filename,
                text=chunk.body,
                position=str(chunk.index),
            )
            for chunk in chunks
        ]

    def search(
        self,
        query: str,
        *,
        collection_ids: list[str],
        scope: str,
        service: str,
        limit: int,
    ) -> list[SearchHit]:
        from raglite import hybrid_search, retrieve_chunks

        metadata_filter: dict[str, object] = {
            "aegis_scope": scope,
            "aegis_collection_id": collection_ids,
        }
        if service:
            metadata_filter["aegis_service"] = service
        chunk_ids, scores = hybrid_search(
            query,
            num_results=limit,
            metadata_filter=metadata_filter,
            config=self._config(),
        )
        chunks = retrieve_chunks(chunk_ids, config=self._config())
        return [
            SearchHit(
                chunk=Chunk(
                    id=str(chunk.id),
                    document_id=str(chunk.document_id),
                    collection_id=_required_metadata_string(
                        chunk.document.metadata_, "aegis_collection_id"
                    ),
                    source_name=chunk.document.filename,
                    text=chunk.body,
                    position=str(chunk.index),
                ),
                score=float(score),
            )
            for chunk, score in zip(chunks, scores, strict=True)
        ]


def _required_metadata_string(metadata: dict[str, object], key: str) -> str:
    """读取 RAGLite 规范化后的单值元数据，缺失或畸形时拒绝生成跨边界结果。"""
    value = metadata.get(key)
    if not isinstance(value, list) or len(value) != 1 or not isinstance(value[0], str):
        raise RuntimeError(f"RAGLite document metadata {key!r} is invalid")
    normalized = value[0].strip()
    if not normalized:
        raise RuntimeError(f"RAGLite document metadata {key!r} is invalid")
    return normalized
