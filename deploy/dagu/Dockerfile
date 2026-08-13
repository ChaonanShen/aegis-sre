FROM golang:1.26.5-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/mcp-call ./cmd/mcp-call
COPY internal/mcpcall ./internal/mcpcall
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/mcp-call ./cmd/mcp-call

FROM ghcr.io/dagu-org/dagu:2.13.0
COPY --from=build /out/mcp-call /usr/local/bin/mcp-call
