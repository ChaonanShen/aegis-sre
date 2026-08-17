from __future__ import annotations

import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import ModuleType

import pytest

from aegis_raglite_sidecar.offline_models import EMBEDDER, _configure_embedder, require_model_files


def test_require_model_files_rejects_incomplete_image(tmp_path: Path) -> None:
    with pytest.raises(RuntimeError, match="offline model artifacts are missing"):
        require_model_files(tmp_path)


def test_require_model_files_accepts_complete_image(tmp_path: Path) -> None:
    for relative in (
        "xlm-roberta-base/tokenizer.json",
        "sat-1l-sm/config.json",
        "sat-1l-sm/model_optimized.onnx",
        "bge-m3/bge-m3-Q4_K_M.gguf",
    ):
        path = tmp_path / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch()
    require_model_files(tmp_path)


def test_local_embedder_is_singleton_across_concurrent_vendor_calls(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    constructions = 0

    class FakeLlama:
        def __init__(self, **_kwargs: object) -> None:
            nonlocal constructions
            constructions += 1

        def n_ctx(self) -> int:
            return 512

        def n_embd(self) -> int:
            return 1024

        def set_cache(self, _cache: object) -> None:
            pass

    class FakeProvider:
        pass

    litellm = ModuleType("litellm")
    litellm.register_model = lambda _model: None  # type: ignore[attr-defined]
    lazy_llama = ModuleType("raglite._lazy_llama")
    lazy_llama.LLAMA_POOLING_TYPE_NONE = 0  # type: ignore[attr-defined]
    lazy_llama.Llama = FakeLlama  # type: ignore[attr-defined]
    lazy_llama.LlamaRAMCache = object  # type: ignore[attr-defined]
    lazy_llama.llama_supports_gpu_offload = lambda: False  # type: ignore[attr-defined]
    raglite_litellm = ModuleType("raglite._litellm")
    raglite_litellm.LlamaCppPythonLLM = FakeProvider  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "litellm", litellm)
    monkeypatch.setitem(sys.modules, "raglite._lazy_llama", lazy_llama)
    monkeypatch.setitem(sys.modules, "raglite._litellm", raglite_litellm)

    _configure_embedder(tmp_path / "model.gguf")
    with ThreadPoolExecutor(max_workers=4) as executor:
        instances = list(
            executor.map(lambda _: FakeProvider.llm(EMBEDDER, embedding=True), range(4))
        )

    assert constructions == 1
    assert all(instance is instances[0] for instance in instances)
