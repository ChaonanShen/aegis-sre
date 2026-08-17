FROM python:3.11.13-slim-bookworm@sha256:86adf8dbadc3d6e82ee5dd2c74bec2e1c2467cdad47886280501df722372d2e1 AS dependencies

RUN apt-get update \
    && apt-get install --yes --no-install-recommends build-essential cmake \
    && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir uv==0.8.4
WORKDIR /app
COPY internal/adapters/raglite/sidecar/pyproject.toml internal/adapters/raglite/sidecar/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

FROM dependencies AS build
COPY internal/adapters/raglite/sidecar/src ./src
RUN uv sync --frozen --no-dev

FROM python:3.11.13-slim-bookworm@sha256:86adf8dbadc3d6e82ee5dd2c74bec2e1c2467cdad47886280501df722372d2e1 AS models
COPY internal/adapters/raglite/sidecar/fetch_models.py /usr/local/bin/fetch-raglite-models
# 模型缓存独立于业务源码层；普通代码重建和失败重试都复用已校验的完整文件。
RUN --mount=type=cache,id=aegis-raglite-models,target=/var/cache/aegis-models \
    python /usr/local/bin/fetch-raglite-models /var/cache/aegis-models
RUN --mount=type=cache,id=aegis-raglite-models,target=/var/cache/aegis-models \
    mkdir -p /opt/aegis \
    && cp -a /var/cache/aegis-models /opt/aegis/models

FROM dependencies AS test-dependencies
RUN uv sync --frozen --extra test --no-install-project

FROM test-dependencies AS test
COPY internal/adapters/raglite/sidecar/src ./src
RUN uv sync --frozen --extra test
COPY internal/adapters/raglite/sidecar/tests ./tests
RUN uv run --frozen pytest \
    && uv run --frozen ruff check .

FROM python:3.11.13-slim-bookworm@sha256:86adf8dbadc3d6e82ee5dd2c74bec2e1c2467cdad47886280501df722372d2e1
RUN apt-get update \
    && apt-get install --yes --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 aegis \
    && useradd --system --uid 10001 --gid aegis --home-dir /nonexistent aegis \
    && mkdir -p /app /var/lib/aegis/raglite \
    && chown -R aegis:aegis /var/lib/aegis/raglite
COPY --from=build /app/.venv /app/.venv
# uv 默认以 editable 方式安装本地项目，运行镜像必须同时保留其 /app/src 目标。
COPY --from=build /app/src /app/src
COPY --from=models /opt/aegis/models /opt/aegis/models
COPY internal/adapters/raglite/sidecar/healthcheck.py /usr/local/bin/raglite-healthcheck
ENV PATH=/app/.venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    AEGIS_RAGLITE_DATA_DIR=/var/lib/aegis/raglite \
    AEGIS_RAGLITE_MODEL_DIR=/opt/aegis/models \
    HOME=/app \
    HF_HUB_OFFLINE=1 \
    HF_HOME=/opt/aegis/model-cache/huggingface \
    LITELLM_LOCAL_MODEL_COST_MAP=True \
    XDG_CACHE_HOME=/opt/aegis/model-cache \
    XDG_DATA_HOME=/var/lib/aegis/raglite/xdg-data
# 运行网络为 internal；RAGLite 必需的 DuckDB 扩展必须在构建阶段离线固化。
RUN python -c 'import duckdb; db = duckdb.connect(); db.execute("INSTALL fts"); db.execute("INSTALL vss")' \
    && python -c "import aegis_raglite_sidecar"
VOLUME ["/var/lib/aegis/raglite"]
EXPOSE 8090
USER aegis
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=20 CMD ["python", "/usr/local/bin/raglite-healthcheck"]
ENTRYPOINT ["uvicorn", "aegis_raglite_sidecar.main:app", "--host=0.0.0.0", "--port=8090", "--workers=1"]
