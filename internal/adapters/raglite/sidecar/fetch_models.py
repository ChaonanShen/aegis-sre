"""Download the exact offline model artifacts used by the RAGLite image."""

from __future__ import annotations

import hashlib
import shutil
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Artifact:
    relative_path: str
    url: str
    sha256: str


ARTIFACTS = (
    Artifact(
        "xlm-roberta-base/tokenizer.json",
        "https://huggingface.co/FacebookAI/xlm-roberta-base/resolve/"
        "e73636d4f797dec63c3081bb6ed5c7b0bb3f2089/tokenizer.json",
        "a898ea75433890f6610f4e470b8ebeb0c21dce5c8dd61f892eb09eb5919d2e2c",
    ),
    Artifact(
        "sat-1l-sm/config.json",
        "https://huggingface.co/segment-any-text/sat-1l-sm/resolve/"
        "00a783439c201b20ee91ee1624dc817f1bf0e578/config.json",
        "52252a4c239327ba46ee2843ca95017c2effc9abfb2163c121f1ee66ca9e1ddc",
    ),
    Artifact(
        "sat-1l-sm/model_optimized.onnx",
        "https://huggingface.co/segment-any-text/sat-1l-sm/resolve/"
        "00a783439c201b20ee91ee1624dc817f1bf0e578/model_optimized.onnx",
        "7ba39f92d8060d6a85fc4485e7fb8678278f48284d1b7db73219e942740f51aa",
    ),
    Artifact(
        "bge-m3/bge-m3-Q4_K_M.gguf",
        "https://huggingface.co/lm-kit/bge-m3-gguf/resolve/"
        "9379ce497e8814b200f2dc0d18eb4045426dcb8c/bge-m3-Q4_K_M.gguf",
        "e251234fcb7d050991a6be491952f485bf5c641dd10c3272dc1301fd281ad50f",
    ),
)


def fetch(root: Path, artifact: Artifact) -> None:
    target = root / artifact.relative_path
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_file() and sha256(target) == artifact.sha256:
        return
    temporary = target.with_suffix(f"{target.suffix}.part")
    digest = hashlib.sha256()
    with urllib.request.urlopen(artifact.url) as response, temporary.open("wb") as output:
        while chunk := response.read(1024 * 1024):
            digest.update(chunk)
            output.write(chunk)
    if digest.hexdigest() != artifact.sha256:
        temporary.unlink(missing_ok=True)
        raise RuntimeError(f"checksum mismatch for {artifact.relative_path}")
    shutil.move(temporary, target)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: fetch_models.py MODEL_DIR")
    root = Path(sys.argv[1])
    for artifact in ARTIFACTS:
        fetch(root, artifact)


if __name__ == "__main__":
    main()
