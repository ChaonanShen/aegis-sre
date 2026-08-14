FROM golang:1.26.5-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/grafana-bootstrap ./cmd/grafana-bootstrap
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/grafana-bootstrap ./cmd/grafana-bootstrap

FROM alpine:3.23.3
COPY --from=build /out/grafana-bootstrap /usr/local/bin/grafana-bootstrap
ENTRYPOINT ["/usr/local/bin/grafana-bootstrap"]
