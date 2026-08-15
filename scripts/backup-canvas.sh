#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: $0 /absolute/path/canvas.db /absolute/path/backup.db" >&2
  exit 2
fi
source_db=$1
backup_db=$2

case "$source_db:$backup_db" in
  /*:/*) ;;
  *) echo "Canvas database and backup paths must be absolute" >&2; exit 2 ;;
esac
if [ ! -f "$source_db" ]; then
  echo "Canvas database does not exist: $source_db" >&2
  exit 1
fi
if [ -e "$backup_db" ]; then
  echo "Refusing to overwrite existing backup: $backup_db" >&2
  exit 1
fi
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 CLI is required for the online backup API" >&2
  exit 1
fi

backup_dir=$(dirname "$backup_db")
mkdir -p "$backup_dir"
temporary_dir=$(mktemp -d "${TMPDIR:-/tmp}/aegis-canvas-backup.XXXXXX")
trap 'rm -rf "$temporary_dir"' EXIT HUP INT TERM
temporary_db="$temporary_dir/canvas.db"

sqlite3 "$source_db" "PRAGMA busy_timeout=5000; PRAGMA quick_check;" | grep -qx ok
sqlite3 "$source_db" ".timeout 5000" ".backup '$temporary_db'"
sqlite3 "$temporary_db" "PRAGMA integrity_check;" | grep -qx ok
mv "$temporary_db" "$backup_db"
chmod 600 "$backup_db"
echo "Canvas backup created: $backup_db"
