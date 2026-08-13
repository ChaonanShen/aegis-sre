# Grafana MCP deployment

This deployment pins the official `grafana/mcp-grafana` v1.0.0 multi-platform image by digest.
The default service is read-only and exposes only the categories used by Aegis. The optional
write service has a separate profile and must use a different, least-privilege Grafana service
account.

The compose services deliberately publish no host port. mcp-grafana v1.0.0 validates Host and
Origin, but does not authenticate an incoming MCP client. Production traffic must therefore go
through a trusted internal gateway that terminates TLS, validates the caller Bearer token, rewrites
Host to the configured service name, and then joins `aegis-mcp`. Do not publish port 8000 directly.
The versioned client policy points at that gateway and rereads its independent caller token file on
every request.

The Grafana service account token is also mounted as a file. The official server rereads it for
every Grafana request, so rotation does not require restarting Aegis or mcp-grafana.

Start the read-only service after setting `GRAFANA_URL` and `GRAFANA_READ_TOKEN_FILE`:

```sh
docker compose -f deploy/grafana-mcp/compose.yaml up -d grafana-read
```

The write profile is opt-in and is not present in the default Aegis MCP policy:

```sh
docker compose -f deploy/grafana-mcp/compose.yaml --profile write up -d grafana-write
```

