"""Runtime configuration loaded from environment."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Config:
    data_dir: Path
    token_file: Path
    max_upload_bytes: int = 10 * 1024 * 1024
    worker_poll_seconds: float = 0.25
    embedder: str = "llama-cpp-python/lm-kit/bge-m3-gguf/*Q4_K_M.gguf@512"

    @classmethod
    def from_env(cls) -> Config:
        data_dir = Path(os.environ.get("AEGIS_RAGLITE_DATA_DIR", "/var/lib/aegis/raglite"))
        token_file = Path(os.environ.get("AEGIS_RAGLITE_TOKEN_FILE", ""))
        if not data_dir.is_absolute():
            raise ValueError("AEGIS_RAGLITE_DATA_DIR must be absolute")
        if not token_file.is_absolute() or not token_file.is_file():
            raise ValueError("AEGIS_RAGLITE_TOKEN_FILE must be a readable regular file")
        max_upload = int(os.environ.get("AEGIS_RAGLITE_MAX_UPLOAD_BYTES", str(10 * 1024 * 1024)))
        if max_upload <= 0:
            raise ValueError("AEGIS_RAGLITE_MAX_UPLOAD_BYTES must be positive")
        return cls(data_dir=data_dir, token_file=token_file, max_upload_bytes=max_upload)


class TokenSource:
    def __init__(self, path: Path) -> None:
        self._path = path

    def read(self) -> str:
        token = self._path.read_text(encoding="utf-8").strip()
        if not token or any(character in token for character in "\r\n\x00"):
            raise ValueError("provider token file is empty or invalid")
        return token
