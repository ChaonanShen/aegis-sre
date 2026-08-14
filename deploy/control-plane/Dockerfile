FROM golang:1.26.5-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/control-plane ./cmd/control-plane
COPY internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/control-plane ./cmd/control-plane

FROM node:22.23.1-alpine3.23
ARG CODEX_CLI_VERSION=0.144.4
RUN npm install --global "@openai/codex@${CODEX_CLI_VERSION}" \
    && npm cache clean --force \
    && mkdir -p /var/lib/aegis/codex /workspace \
    && chown -R node:node /var/lib/aegis/codex /workspace
COPY --from=build /out/control-plane /usr/local/bin/control-plane
ENV CODEX_HOME=/var/lib/aegis/codex \
    AEGIS_CODEX_COMMAND=/usr/local/bin/codex \
    AEGIS_AGENT_WORKING_DIRECTORY=/workspace
VOLUME ["/var/lib/aegis/codex"]
WORKDIR /workspace
USER node
ENTRYPOINT ["/usr/local/bin/control-plane"]
