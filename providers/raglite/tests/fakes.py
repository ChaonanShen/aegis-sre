from __future__ import annotations

from pathlib import Path

from aegis_raglite_provider.backend import Chunk, SearchHit
from aegis_raglite_provider.models import Collection, Document


class FakeBackend:
    def __init__(self) -> None:
        self.indexed: list[tuple[Path, Document, Collection]] = []
        self.deleted: list[str] = []
        self.search_calls: list[dict[str, object]] = []
        self.fail_index = False
        self.fail_delete = False
        self.chunks: dict[str, list[Chunk]] = {}

    def check(self) -> None:
        return None

    def index(self, path: Path, document: Document, collection: Collection) -> None:
        if self.fail_index:
            raise RuntimeError("embedding failed")
        self.indexed.append((path, document, collection))
        self.chunks[document.id] = [
            Chunk(
                id="chunk-internal-1",
                document_id=document.id,
                collection_id=collection.id,
                source_name=document.name,
                text="restart the checkout deployment",
                position="0",
            )
        ]

    def delete(self, document_id: str) -> None:
        if self.fail_delete:
            raise RuntimeError("index delete failed")
        self.deleted.append(document_id)
        self.chunks.pop(document_id, None)

    def list_chunks(self, document_id: str) -> list[Chunk]:
        return self.chunks.get(document_id, [])

    def search(
        self,
        query: str,
        *,
        collection_ids: list[str],
        scope: str,
        service: str,
        limit: int,
    ) -> list[SearchHit]:
        self.search_calls.append(
            {
                "query": query,
                "collection_ids": collection_ids,
                "scope": scope,
                "service": service,
                "limit": limit,
            }
        )
        chunks = [chunk for values in self.chunks.values() for chunk in values]
        return [SearchHit(chunk=chunk, score=0.5) for chunk in chunks[:limit]]
