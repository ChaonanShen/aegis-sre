from __future__ import annotations

import hashlib
import io
from pathlib import Path

import pytest

from aegis_raglite_provider.original_store import OriginalStore


def test_save_sanitizes_name_hashes_and_reads_original(tmp_path: Path) -> None:
    store = OriginalStore(tmp_path, max_bytes=1024)
    payload = b"# recovery runbook\n"

    relative, size, digest = store.save(
        "kbs_abcdefgh", "doc_abcdefgh", "../../manual 中文.md", io.BytesIO(payload)
    )

    assert relative == "originals/kbs_abcdefgh/doc_abcdefgh/manual_.md"
    assert size == len(payload)
    assert digest == hashlib.sha256(payload).hexdigest()
    with store.open(relative) as content:
        assert content.read() == payload


def test_save_rejects_oversize_without_leaving_partial_file(tmp_path: Path) -> None:
    store = OriginalStore(tmp_path, max_bytes=3)

    with pytest.raises(ValueError, match="size limit"):
        store.save("kbs_abcdefgh", "doc_abcdefgh", "large.md", io.BytesIO(b"four"))

    assert list((tmp_path / "tmp").iterdir()) == []
    assert list((tmp_path / "originals").rglob("*")) == []


@pytest.mark.parametrize("path", ["../secret", "/etc/passwd", "originals/../../secret"])
def test_resolve_rejects_path_traversal(tmp_path: Path, path: str) -> None:
    store = OriginalStore(tmp_path, max_bytes=1024)
    with pytest.raises(ValueError):
        store.resolve(path)

