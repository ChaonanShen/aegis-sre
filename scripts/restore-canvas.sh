#!/bin/sh
set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: $0 /absolute/path/backup.db /absolute/path/canvas.db" >&2
  exit 2
fi
backup_db=$1
target_db=$2
case "$backup_db:$target_db" in
  /*:/*) ;;
  *) echo "Canvas database and backup paths must be absolute" >&2; exit 2 ;;
esac
if [ ! -f "$backup_db" ]; then
  echo "Canvas backup does not exist: $backup_db" >&2
  exit 1
fi
if [ -e "$target_db" ]; then
  echo "Refusing to overwrite existing database: $target_db" >&2
  exit 1
fi
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 CLI is required for restore verification" >&2
  exit 1
fi
sqlite3 "$backup_db" "PRAGMA integrity_check;" | grep -qx ok
target_dir=$(dirname "$target_db")
mkdir -p "$target_dir"
temporary_db="$target_dir/.canvas.restore.$$.db"
trap 'rm -f "$temporary_db"' EXIT HUP INT TERM
cp "$backup_db" "$temporary_db"
sqlite3 "$temporary_db" "PRAGMA integrity_check;" | grep -qx ok
chmod 600 "$temporary_db"
mv "$temporary_db" "$target_db"
echo "Canvas database restored: $target_db"
