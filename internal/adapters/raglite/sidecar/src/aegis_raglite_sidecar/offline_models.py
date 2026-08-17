"""Bind RAGLite's private model loaders to immutable image-local artifacts."""

from __future__ import annotations

import contextlib
import os
import threading
import warnings
from functools import cache
from io import StringIO
from pathlib import Path
from typing import Any

EMBEDDER = "llama-cpp-python/aegis-local/bge-m3-Q4_K_M.gguf@512"


def require_model_files(model_dir: Path) -> None:
    required = (
        model_dir / "xlm-roberta-base" / "tokenizer.json",
        model_dir / "sat-1l-sm" / "config.json",
        model_dir / "sat-1l-sm" / "model_optimized.onnx",
        model_dir / "bge-m3" / "bge-m3-Q4_K_M.gguf",
    )
    missing = [str(path) for path in required if not path.is_file()]
    if missing:
        raise RuntimeError(f"offline model artifacts are missing: {', '.join(missing)}")


def configure_offline_models(model_dir: Path) -> None:
    """Replace network-first vendor loaders inside the provider adapter boundary."""
    require_model_files(model_dir)
    _configure_sentence_splitter(model_dir)
    _configure_embedder(model_dir / "bge-m3" / "bge-m3-Q4_K_M.gguf")


def _configure_sentence_splitter(model_dir: Path) -> None:
    import raglite._split_sentences as sentence_splitter
    from wtpsplit_lite import SaT

    @cache
    def load_sat() -> tuple[SaT, dict[str, Any]]:
        sat = SaT(
            model_dir / "sat-1l-sm",
            tokenizer_name_or_path=model_dir / "xlm-roberta-base",
            hub_prefix=None,
        )
        return sat, {"stride": 128, "block_size": 256, "weighting": "hat"}

    # RAGLite 1.1.1 的公开配置不能传入 SaT；此替换被严格限制在 Provider adapter 内。
    sentence_splitter._load_sat = load_sat


def _configure_embedder(model_path: Path) -> None:
    import litellm
    from raglite._lazy_llama import (
        LLAMA_POOLING_TYPE_NONE,
        Llama,
        LlamaRAMCache,
        llama_supports_gpu_offload,
    )
    from raglite._litellm import LlamaCppPythonLLM

    instance: Llama | None = None
    load_lock = threading.Lock()

    def load_local(model: str, **kwargs: Any) -> Llama:
        nonlocal instance
        if model != EMBEDDER:
            raise RuntimeError(f"unexpected llama-cpp-python model: {model}")
        if instance is not None:
            return instance
        with load_lock:
            if instance is not None:
                return instance
            # RAGLite 探测维度和实际 embedding 的参数不同，但必须共享同一个本地模型实例。
            kwargs.setdefault("pooling_type", LLAMA_POOLING_TYPE_NONE)
            with contextlib.redirect_stderr(StringIO()), warnings.catch_warnings():
                warnings.filterwarnings("ignore", category=UserWarning)
                loaded = Llama(
                    model_path=str(model_path),
                    n_ctx=512,
                    n_gpu_layers=-1,
                    verbose=False,
                    n_batch=512,
                    n_ubatch=512,
                    **kwargs,
                )
            if llama_supports_gpu_offload() or (os.cpu_count() or 1) >= 8:
                loaded.set_cache(LlamaRAMCache())
            litellm.register_model(
                {
                    EMBEDDER.removeprefix("llama-cpp-python/"): {
                        "max_tokens": loaded.n_ctx(),
                        "max_input_tokens": loaded.n_ctx(),
                        "max_output_tokens": None,
                        "input_cost_per_token": 0.0,
                        "output_cost_per_token": 0.0,
                        "output_vector_size": loaded.n_embd(),
                        "litellm_provider": "llama-cpp-python",
                        "mode": "embedding",
                    }
                }
            )
            instance = loaded
        return instance

    # llama-cpp-python 的 from_pretrained 会先联网枚举仓库；本地加载避免离线运行时触网。
    LlamaCppPythonLLM.llm = staticmethod(load_local)
