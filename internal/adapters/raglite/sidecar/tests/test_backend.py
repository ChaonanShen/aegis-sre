from __future__ import annotations

import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import ModuleType

import pytest

from aegis_raglite_sidecar import backend as backend_module
from aegis_raglite_sidecar.backend import RAGLiteBackend, _required_metadata_string
from aegis_raglite_sidecar.offline_models import EMBEDDER


def test_required_metadata_string_reads_raglite_normalized_value() -> None:
    assert (
        _required_metadata_string({"aegis_collection_id": ["kbs_abcdefgh"]}, "aegis_collection_id")
        == "kbs_abcdefgh"
    )


@pytest.mark.parametrize(
    "metadata",
    [
        {},
        {"aegis_collection_id": "kbs_abcdefgh"},
        {"aegis_collection_id": []},
        {"aegis_collection_id": ["kbs_a", "kbs_b"]},
        {"aegis_collection_id": [""]},
    ],
)
def test_required_metadata_string_rejects_missing_or_ambiguous_values(
    metadata: dict[str, object],
) -> None:
    with pytest.raises(RuntimeError, match="metadata 'aegis_collection_id' is invalid"):
        _required_metadata_string(metadata, "aegis_collection_id")


def test_raglite_config_initializes_models_only_once_under_concurrency(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = 0

    def configure(_model_dir: Path) -> None:
        nonlocal calls
        calls += 1
        time.sleep(0.05)

    class FakeConfig:
        def __init__(self, **values: object) -> None:
            self.values = values

    raglite = ModuleType("raglite")
    raglite.RAGLiteConfig = FakeConfig  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "raglite", raglite)
    monkeypatch.setattr(backend_module, "configure_offline_models", configure)
    backend = RAGLiteBackend(tmp_path / "raglite.db", EMBEDDER, tmp_path / "models")

    with ThreadPoolExecutor(max_workers=4) as executor:
        configs = list(executor.map(lambda _: backend._config(), range(4)))

    assert calls == 1
    assert all(config is configs[0] for config in configs)
