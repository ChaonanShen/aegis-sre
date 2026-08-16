from __future__ import annotations

import pytest

from aegis_raglite_sidecar.backend import _required_metadata_string


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
