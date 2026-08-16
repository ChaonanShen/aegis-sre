from __future__ import annotations

from pathlib import Path

from fakes import FakeBackend
from fastapi.testclient import TestClient

from aegis_raglite_sidecar.api import create_app
from aegis_raglite_sidecar.config import TokenSource
from aegis_raglite_sidecar.original_store import OriginalStore
from aegis_raglite_sidecar.repository import Repository
from aegis_raglite_sidecar.service import KnowledgeService


def new_client(tmp_path: Path) -> tuple[TestClient, KnowledgeService, FakeBackend]:
    token_file = tmp_path / "token"
    token_file.write_text("provider-secret")
    backend = FakeBackend()
    service = KnowledgeService(
        Repository(tmp_path / "provider.sqlite"),
        OriginalStore(tmp_path, max_bytes=1024),
        backend,
    )
    app = create_app(service, TokenSource(token_file))
    return TestClient(app), service, backend


def headers(scope: str = "scp_scope-a") -> dict[str, str]:
    return {
        "Authorization": "Bearer provider-secret",
        "X-Aegis-Scope": scope,
    }


def test_api_requires_bearer_and_scope(tmp_path: Path) -> None:
    client, _, _ = new_client(tmp_path)
    assert client.get("/v1/collections?folder_uid=folder-a").status_code == 401
    assert (
        client.get(
            "/v1/collections?folder_uid=folder-a",
            headers={"Authorization": "Bearer provider-secret"},
        ).status_code
        == 400
    )


def test_collection_upload_index_search_and_download(tmp_path: Path) -> None:
    client, service, _ = new_client(tmp_path)
    response = client.post(
        "/v1/collections",
        headers=headers(),
        json={"id": "kbs_abcdefgh", "name": "Operations", "folder_uid": "folder-a"},
    )
    assert response.status_code == 201

    response = client.post(
        "/v1/collections/kbs_abcdefgh/documents",
        headers=headers(),
        data={"id": "doc_abcdefgh", "service": "checkout", "tags": '["prod"]'},
        files={"file": ("runbook.md", b"# Restart\nrestart deployment", "text/markdown")},
    )
    assert response.status_code == 201
    assert response.json()["sha256"]

    response = client.post("/v1/documents/doc_abcdefgh:index", headers=headers())
    assert response.status_code == 202
    assert service.run_once()

    response = client.post(
        "/v1/search",
        headers=headers(),
        json={
            "query": "restart",
            "collections": ["kbs_abcdefgh"],
            "service": "checkout",
            "limit": 5,
            "threshold": 0,
        },
    )
    assert response.status_code == 200
    assert response.json()["hits"][0]["chunk"]["document_id"] == "doc_abcdefgh"
    assert response.json()["hits"][0]["chunk"]["collection_id"] == "kbs_abcdefgh"

    response = client.get("/v1/documents/doc_abcdefgh/content", headers=headers())
    assert response.status_code == 200
    assert response.content.startswith(b"# Restart")


def test_cross_scope_resources_are_not_disclosed(tmp_path: Path) -> None:
    client, _, _ = new_client(tmp_path)
    client.post(
        "/v1/collections",
        headers=headers("scp_scope-a"),
        json={"id": "kbs_abcdefgh", "name": "Operations", "folder_uid": "folder-a"},
    )

    response = client.get("/v1/collections/kbs_abcdefgh", headers=headers("scp_scope-b"))
    assert response.status_code == 404
    assert response.json()["code"] == "not_found"


def test_scope_migration_moves_collection_without_reuploading_documents(tmp_path: Path) -> None:
    client, _, backend = new_client(tmp_path)
    client.post(
        "/v1/collections",
        headers=headers("scp_legacy"),
        json={"id": "kbs_abcdefgh", "name": "Operations", "folder_uid": "folder-a"},
    )
    client.post(
        "/v1/collections/kbs_abcdefgh/documents",
        headers=headers("scp_legacy"),
        data={"id": "doc_abcdefgh"},
        files={"file": ("runbook.md", b"# Restart", "text/markdown")},
    )

    response = client.post(
        "/v1/collections/kbs_abcdefgh/scope-migrations",
        headers=headers("scp_legacy"),
        json={"target_scope": "scp_folder"},
    )

    assert response.status_code == 200
    assert response.json()["scope"] == "scp_folder"
    assert (
        client.get("/v1/documents/doc_abcdefgh", headers=headers("scp_folder")).status_code
        == 200
    )
    assert backend.indexed == []


def test_admin_inventory_requires_service_auth_but_not_resource_scope(tmp_path: Path) -> None:
    client, _, _ = new_client(tmp_path)
    client.post(
        "/v1/collections",
        headers=headers("scp_deleted"),
        json={"id": "kbs_abcdefgh", "name": "Operations", "folder_uid": "deleted"},
    )
    assert client.get("/v1/admin/ownership-inventory").status_code == 401
    response = client.get("/v1/admin/ownership-inventory", headers=headers("scp_inventory"))
    assert response.status_code == 200
    assert response.json()["items"][0]["folder_uid"] == "deleted"


def test_invalid_threshold_returns_stable_capability_error(tmp_path: Path) -> None:
    client, _, _ = new_client(tmp_path)
    client.post(
        "/v1/collections",
        headers=headers(),
        json={"id": "kbs_abcdefgh", "name": "Operations", "folder_uid": "folder-a"},
    )
    response = client.post(
        "/v1/search",
        headers=headers(),
        json={
            "query": "restart",
            "collections": ["kbs_abcdefgh"],
            "limit": 5,
            "threshold": 0.2,
        },
    )
    assert response.status_code == 422
    assert response.json()["code"] == "capability_unavailable"


def test_job_status_is_bound_to_document_scope(tmp_path: Path) -> None:
    client, _, _ = new_client(tmp_path)
    client.post(
        "/v1/collections",
        headers=headers(),
        json={"id": "kbs_abcdefgh", "name": "Operations", "folder_uid": "folder-a"},
    )
    client.post(
        "/v1/collections/kbs_abcdefgh/documents",
        headers=headers(),
        data={"id": "doc_abcdefgh"},
        files={"file": ("runbook.md", b"# Restart", "text/markdown")},
    )
    job = client.post("/v1/documents/doc_abcdefgh:index", headers=headers()).json()

    assert client.get(f"/v1/jobs/{job['id']}", headers=headers()).status_code == 200
    hidden = client.get(f"/v1/jobs/{job['id']}", headers=headers("scp_scope-b"))
    assert hidden.status_code == 404


def test_duplicate_upload_does_not_replace_original(tmp_path: Path) -> None:
    client, _, _ = new_client(tmp_path)
    client.post(
        "/v1/collections",
        headers=headers(),
        json={"id": "kbs_abcdefgh", "name": "Operations", "folder_uid": "folder-a"},
    )
    endpoint = "/v1/collections/kbs_abcdefgh/documents"
    first = client.post(
        endpoint,
        headers=headers(),
        data={"id": "doc_abcdefgh"},
        files={"file": ("runbook.md", b"first", "text/markdown")},
    )
    second = client.post(
        endpoint,
        headers=headers(),
        data={"id": "doc_abcdefgh"},
        files={"file": ("runbook.md", b"second", "text/markdown")},
    )

    assert first.status_code == 201
    assert second.status_code == 409
    assert client.get("/v1/documents/doc_abcdefgh/content", headers=headers()).content == b"first"


def test_token_file_is_reloaded_for_rotation(tmp_path: Path) -> None:
    client, _, _ = new_client(tmp_path)
    token_file = tmp_path / "token"
    token_file.write_text("rotated-secret")

    assert client.get("/healthz", headers=headers()).status_code == 401
    assert (
        client.get(
            "/healthz",
            headers={"Authorization": "Bearer rotated-secret"},
        ).status_code
        == 200
    )
