#!/usr/bin/env python3
"""Authenticated container healthcheck."""

from pathlib import Path
from urllib.request import Request, urlopen

token_file = Path("/run/secrets/knowledge-provider-token")
token = token_file.read_text(encoding="utf-8").strip()
request = Request(
    "http://127.0.0.1:8090/healthz",
    headers={"Authorization": f"Bearer {token}"},
)
with urlopen(request, timeout=3) as response:
    if response.status != 200:
        raise SystemExit(1)
