"""Internal authenticated REST API."""

from __future__ import annotations

import hmac
import json
from contextlib import asynccontextmanager
from dataclasses import asdict
from typing import Annotated
from urllib.parse import quote

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from aegis_raglite_provider.config import TokenSource
from aegis_raglite_provider.repository import ConflictError, NotFoundError
from aegis_raglite_provider.service import CapabilityError, KnowledgeService, ValidationError


class CollectionCreate(BaseModel):
    id: str
    name: str
    folder_uid: str


class CollectionUpdate(BaseModel):
    name: str
    status: str


class CollectionScopeMigration(BaseModel):
    target_scope: str


class DocumentUpdate(BaseModel):
    service: str = ""
    tags: list[str] = Field(default_factory=list)


class SearchRequest(BaseModel):
    query: str
    collections: list[str]
    service: str = ""
    limit: int = 10
    threshold: float = 0


def create_app(
    service: KnowledgeService,
    token_source: TokenSource,
    *,
    manage_worker: bool = False,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_: FastAPI):
        if manage_worker:
            service.start()
        yield
        if manage_worker:
            service.stop()

    app = FastAPI(title="Aegis RAGLite Provider", version="1.0", lifespan=lifespan)

    def authorize(authorization: Annotated[str | None, Header()] = None) -> None:
        try:
            expected = token_source.read()
        except (OSError, ValueError) as error:
            raise HTTPException(
                status_code=503, detail="provider credential unavailable"
            ) from error
        prefix = "Bearer "
        supplied = (
            authorization[len(prefix) :]
            if authorization and authorization.startswith(prefix)
            else ""
        )
        if not supplied or not hmac.compare_digest(supplied, expected):
            raise HTTPException(status_code=401, detail="invalid provider credential")

    def scope(
        x_aegis_scope: Annotated[str | None, Header()] = None,
        _: None = Depends(authorize),
    ) -> str:
        if not x_aegis_scope or not x_aegis_scope.startswith("scp_") or len(x_aegis_scope) > 128:
            raise HTTPException(status_code=400, detail="valid X-Aegis-Scope is required")
        return x_aegis_scope

    @app.exception_handler(NotFoundError)
    async def not_found(_, error: NotFoundError):
        return _problem(404, "not_found", str(error))

    @app.exception_handler(ConflictError)
    async def conflict(_, error: ConflictError):
        return _problem(409, "conflict", str(error))

    @app.exception_handler(ValidationError)
    async def invalid(_, error: ValidationError):
        return _problem(422, "invalid_argument", str(error))

    @app.exception_handler(CapabilityError)
    async def unavailable(_, error: CapabilityError):
        return _problem(422, "capability_unavailable", str(error))

    @app.get("/healthz", dependencies=[Depends(authorize)])
    def health() -> dict[str, str]:
        service.check()
        return {"status": "ok"}

    @app.get("/v1/collections")
    def list_collections(folder_uid: str, actor_scope: str = Depends(scope)):
        items = service.list_collections(actor_scope, folder_uid)
        return {"items": [asdict(item) for item in items], "total": len(items)}

    @app.post("/v1/collections", status_code=status.HTTP_201_CREATED)
    def create_collection(body: CollectionCreate, actor_scope: str = Depends(scope)):
        return asdict(
            service.create_collection(
                collection_id=body.id,
                name=body.name,
                folder_uid=body.folder_uid,
                scope=actor_scope,
            )
        )

    @app.get("/v1/collections/{collection_id}")
    def get_collection(collection_id: str, actor_scope: str = Depends(scope)):
        return asdict(service.get_collection(collection_id, actor_scope))

    @app.post("/v1/collections/{collection_id}/scope-migrations")
    def migrate_collection_scope(
        collection_id: str,
        body: CollectionScopeMigration,
        actor_scope: str = Depends(scope),
    ):
        return asdict(
            service.migrate_collection_scope(
                collection_id, actor_scope, body.target_scope
            )
        )

    @app.patch("/v1/collections/{collection_id}")
    def update_collection(
        collection_id: str, body: CollectionUpdate, actor_scope: str = Depends(scope)
    ):
        return asdict(
            service.update_collection(
                collection_id,
                actor_scope,
                name=body.name,
                status=body.status,
            )
        )

    @app.delete("/v1/collections/{collection_id}", status_code=status.HTTP_204_NO_CONTENT)
    def delete_collection(collection_id: str, actor_scope: str = Depends(scope)):
        service.delete_collection(collection_id, actor_scope)

    @app.get("/v1/collections/{collection_id}/documents")
    def list_documents(collection_id: str, actor_scope: str = Depends(scope)):
        items = service.list_documents(collection_id, actor_scope)
        return {"items": [asdict(item) for item in items], "total": len(items)}

    @app.post(
        "/v1/collections/{collection_id}/documents",
        status_code=status.HTTP_201_CREATED,
    )
    def upload_document(
        collection_id: str,
        document_id: Annotated[str, Form(alias="id")],
        file: Annotated[UploadFile, File()],
        service_name: Annotated[str, Form(alias="service")] = "",
        tags: Annotated[str, Form()] = "[]",
        actor_scope: str = Depends(scope),
    ):
        try:
            decoded_tags = json.loads(tags)
        except (json.JSONDecodeError, TypeError) as error:
            raise ValidationError("tags must be a JSON array") from error
        if not isinstance(decoded_tags, list):
            raise ValidationError("tags must be a JSON array")
        parsed_tags = tuple(decoded_tags)
        if not all(isinstance(tag, str) for tag in parsed_tags):
            raise ValidationError("tags must contain strings")
        return asdict(
            service.upload_document(
                collection_id=collection_id,
                document_id=document_id,
                scope=actor_scope,
                filename=file.filename or "document",
                media_type=file.content_type or "application/octet-stream",
                service=service_name,
                tags=parsed_tags,
                content=file.file,
            )
        )

    @app.get("/v1/documents/{document_id}")
    def get_document(document_id: str, actor_scope: str = Depends(scope)):
        return asdict(service.get_document(document_id, actor_scope))

    @app.patch("/v1/documents/{document_id}")
    def update_document(document_id: str, body: DocumentUpdate, actor_scope: str = Depends(scope)):
        return asdict(
            service.update_document(
                document_id,
                actor_scope,
                service=body.service,
                tags=tuple(body.tags),
            )
        )

    @app.delete("/v1/documents/{document_id}", status_code=status.HTTP_204_NO_CONTENT)
    def delete_document(document_id: str, actor_scope: str = Depends(scope)):
        service.delete_document(document_id, actor_scope)

    @app.post("/v1/documents/{document_id}:index", status_code=status.HTTP_202_ACCEPTED)
    def start_index(document_id: str, actor_scope: str = Depends(scope)):
        return asdict(service.start_indexing(document_id, actor_scope))

    @app.post("/v1/documents/{document_id}:stop", status_code=status.HTTP_204_NO_CONTENT)
    def stop_index(document_id: str, actor_scope: str = Depends(scope)):
        service.stop_indexing(document_id, actor_scope)

    @app.get("/v1/documents/{document_id}/chunks")
    def list_chunks(document_id: str, actor_scope: str = Depends(scope)):
        items = service.list_chunks(document_id, actor_scope)
        return {"items": [asdict(item) for item in items], "total": len(items)}

    @app.get("/v1/documents/{document_id}/content")
    def download(document_id: str, actor_scope: str = Depends(scope)):
        document, content = service.open_document(document_id, actor_scope)
        headers = {"Content-Disposition": f"attachment; filename*=UTF-8''{quote(document.name)}"}
        return StreamingResponse(content, media_type=document.media_type, headers=headers)

    @app.post("/v1/search")
    def search(body: SearchRequest, actor_scope: str = Depends(scope)):
        hits = service.search(
            query=body.query,
            collection_ids=body.collections,
            scope=actor_scope,
            service=body.service,
            limit=body.limit,
            threshold=body.threshold,
        )
        return {"hits": [asdict(hit) for hit in hits]}

    @app.get("/v1/jobs/{job_id}")
    def get_job(job_id: str, actor_scope: str = Depends(scope)):
        return asdict(service.get_job(job_id, actor_scope))

    return app


def _problem(status_code: int, code: str, message: str):
    from fastapi.responses import JSONResponse

    return JSONResponse(
        status_code=status_code,
        content={"code": code, "message": message, "retryable": False},
    )
