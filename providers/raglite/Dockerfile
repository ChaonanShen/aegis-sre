FROM python:3.11.13-slim-bookworm@sha256:86adf8dbadc3d6e82ee5dd2c74bec2e1c2467cdad47886280501df722372d2e1 AS build

RUN apt-get update \
    && apt-get install --yes --no-install-recommends build-essential cmake \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir uv==0.8.4
WORKDIR /app
COPY providers/raglite/pyproject.toml providers/raglite/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY providers/raglite/src ./src
RUN uv sync --frozen --no-dev

FROM python:3.11.13-slim-bookworm@sha256:86adf8dbadc3d6e82ee5dd2c74bec2e1c2467cdad47886280501df722372d2e1
RUN apt-get update \
    && apt-get install --yes --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 aegis \
    && useradd --system --uid 10001 --gid aegis --home-dir /nonexistent aegis \
    && mkdir -p /app /var/lib/aegis/raglite \
    && chown -R aegis:aegis /var/lib/aegis/raglite
COPY --from=build /app/.venv /app/.venv
COPY providers/raglite/healthcheck.py /usr/local/bin/raglite-healthcheck
ENV PATH=/app/.venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    AEGIS_RAGLITE_DATA_DIR=/var/lib/aegis/raglite \
    HF_HOME=/var/lib/aegis/raglite/model-cache/huggingface \
    XDG_CACHE_HOME=/var/lib/aegis/raglite/model-cache \
    XDG_DATA_HOME=/var/lib/aegis
VOLUME ["/var/lib/aegis/raglite"]
EXPOSE 8090
USER aegis
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=20 CMD ["python", "/usr/local/bin/raglite-healthcheck"]
ENTRYPOINT ["uvicorn", "aegis_raglite_provider.main:app", "--host=0.0.0.0", "--port=8090", "--workers=1"]
