#!/bin/sh
set -eu

password_file="${DAGU_AUTH_BASIC_PASSWORD_FILE:?DAGU_AUTH_BASIC_PASSWORD_FILE is required}"
if [ ! -r "$password_file" ]; then
  echo "Dagu basic-auth password file is not readable" >&2
  exit 1
fi

DAGU_AUTH_BASIC_PASSWORD="$(tr -d '\r\n' < "$password_file")"
if [ -z "$DAGU_AUTH_BASIC_PASSWORD" ]; then
  echo "Dagu basic-auth password is empty" >&2
  exit 1
fi
export DAGU_AUTH_BASIC_PASSWORD
exec /entrypoint.sh "$@"
