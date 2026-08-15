from __future__ import annotations

from pathlib import Path

import pytest

from aegis_raglite_provider.config import Config, TokenSource


def test_config_requires_absolute_data_and_token_paths(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    token = tmp_path / "token"
    token.write_text("secret")
    monkeypatch.setenv("AEGIS_RAGLITE_DATA_DIR", "relative")
    monkeypatch.setenv("AEGIS_RAGLITE_TOKEN_FILE", str(token))
    with pytest.raises(ValueError, match="DATA_DIR"):
        Config.from_env()

    monkeypatch.setenv("AEGIS_RAGLITE_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("AEGIS_RAGLITE_TOKEN_FILE", str(tmp_path / "missing"))
    with pytest.raises(ValueError, match="TOKEN_FILE"):
        Config.from_env()


def test_token_source_rejects_empty_or_multiline_secret(tmp_path: Path) -> None:
    token = tmp_path / "token"
    source = TokenSource(token)
    token.write_text("  ")
    with pytest.raises(ValueError):
        source.read()
    token.write_text("first\nsecond")
    with pytest.raises(ValueError):
        source.read()
