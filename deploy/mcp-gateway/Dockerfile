FROM golang:1.26.5-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/mcp-gateway ./cmd/mcp-gateway
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/mcp-gateway ./cmd/mcp-gateway

FROM alpine:3.23.3
RUN addgroup -S aegis && adduser -S -G aegis aegis
COPY --from=build /out/mcp-gateway /usr/local/bin/mcp-gateway
USER aegis
ENTRYPOINT ["/usr/local/bin/mcp-gateway"]
