FROM golang:1.26.5-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/mcp-call ./cmd/mcp-call
COPY internal/mcpcall ./internal/mcpcall
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/mcp-call ./cmd/mcp-call

FROM ghcr.io/dagucloud/dagu:2.13.0
COPY --from=build /out/mcp-call /usr/local/bin/mcp-call

# Action 与 allowlist 必须随运行镜像交付；放在 DAGU_HOME 外，避免数据卷遮住只读配置。
COPY --chmod=0444 deploy/dagu/base.yaml /etc/aegis/dagu-base.yaml
COPY --chmod=0444 deploy/mcp/v1/servers.yaml /etc/aegis/mcp-servers.yaml
COPY --chmod=0555 deploy/dagu/entrypoint.sh /usr/local/bin/aegis-dagu-entrypoint
RUN chmod 0555 /etc/aegis
ENV DAGU_BASE_CONFIG=/etc/aegis/dagu-base.yaml
ENV MCP_CALL_CONFIG=/etc/aegis/mcp-servers.yaml
ENTRYPOINT ["/usr/local/bin/aegis-dagu-entrypoint"]
