FROM golang:1.26.5-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/control-plane ./cmd/control-plane
COPY internal ./internal
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/control-plane ./cmd/control-plane

FROM alpine:3.23.3
RUN addgroup -S aegis && adduser -S -G aegis aegis
COPY --from=build /out/control-plane /usr/local/bin/control-plane
USER aegis
ENTRYPOINT ["/usr/local/bin/control-plane"]
