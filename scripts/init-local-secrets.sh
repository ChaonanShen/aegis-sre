#!/bin/sh
set -eu

secret_dir="${1:-deploy/local/secrets}"
mkdir -p "$secret_dir"
chmod 700 "$secret_dir"

generate() {
  target="$secret_dir/$1"
  if [ ! -e "$target" ]; then
    umask 077
    openssl rand -hex 32 > "$target"
  fi
}

generate plugin-token
generate grafana-mcp-caller-token
generate dagu-basic-password
generate grafana-admin-password

# Compose bind-mounts these files into non-root containers. The containing directory is
# private and gitignored; files remain read-only from the containers' perspective.
chmod 644 "$secret_dir"/*
echo "Local secret files are ready in $secret_dir"
