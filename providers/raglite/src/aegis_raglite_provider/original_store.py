"""Safe storage for uploaded originals."""

from __future__ import annotations

import hashlib
import os
import re
import tempfile
from pathlib import Path
from typing import BinaryIO

_SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")


class OriginalStore:
    def __init__(self, root: Path, max_bytes: int) -> None:
        self._root = root.resolve()
        self._tmp = self._root / "tmp"
        self._originals = self._root / "originals"
        self._tmp.mkdir(parents=True, exist_ok=True)
        self._originals.mkdir(parents=True, exist_ok=True)
        self._max_bytes = max_bytes

    def save(
        self,
        collection_id: str,
        document_id: str,
        filename: str,
        content: BinaryIO,
    ) -> tuple[str, int, str]:
        safe_name = self._safe_name(filename)
        target_dir = self._resolve_under(self._originals, collection_id, document_id)
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / safe_name
        digest = hashlib.sha256()
        size = 0
        file_descriptor, temp_name = tempfile.mkstemp(dir=self._tmp, prefix="upload-")
        try:
            with os.fdopen(file_descriptor, "wb") as output:
                while chunk := content.read(1024 * 1024):
                    size += len(chunk)
                    if size > self._max_bytes:
                        raise ValueError("document exceeds configured size limit")
                    digest.update(chunk)
                    output.write(chunk)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temp_name, target)
            relative = target.relative_to(self._root).as_posix()
            return relative, size, digest.hexdigest()
        except Exception:
            Path(temp_name).unlink(missing_ok=True)
            parent = target_dir
            while parent != self._originals:
                try:
                    parent.rmdir()
                except OSError:
                    break
                parent = parent.parent
            raise

    def open(self, relative_path: str) -> BinaryIO:
        path = self.resolve(relative_path)
        return path.open("rb")

    def delete(self, relative_path: str) -> None:
        path = self.resolve(relative_path)
        path.unlink(missing_ok=True)
        parent = path.parent
        while parent != self._originals and parent != self._root:
            try:
                parent.rmdir()
            except OSError:
                break
            parent = parent.parent

    def resolve(self, relative_path: str) -> Path:
        if Path(relative_path).is_absolute():
            raise ValueError("absolute original path is forbidden")
        return self._resolve_under(self._root, relative_path)

    @staticmethod
    def _safe_name(filename: str) -> str:
        name = _SAFE_NAME.sub("_", Path(filename).name).strip("._")
        if not name:
            raise ValueError("document filename is invalid")
        return name[:180]

    @staticmethod
    def _resolve_under(root: Path, *parts: str) -> Path:
        path = root.joinpath(*parts).resolve()
        if path != root and root not in path.parents:
            raise ValueError("path escapes provider data directory")
        return path
