#!/usr/bin/env bash
# Index the KOBAedit1–4 GLB asset folders into the desktop catalogue.
# Metadata is written to data/rust-studio.db; geometry stays where it is.
#
# Usage:
#   bash scripts/index-kobaedit-assets.sh                # index metadata only
#   bash scripts/index-kobaedit-assets.sh --thumbnails   # also render previews
#   bash scripts/index-kobaedit-assets.sh --force        # re-read unchanged files
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
db="${RUST_STUDIO_DATA:-$repo_root/data}/rust-studio.db"
thumbnails="${RUST_STUDIO_DATA:-$repo_root/data}/thumbnails"
make_thumbnails=0
force=0

for arg in "$@"; do
  case "$arg" in
    --thumbnails) make_thumbnails=1 ;;
    --force) force=1 ;;
    -h|--help)
      sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

mkdir -p "$(dirname "$db")"
common=(--db "$db" --json)
if [ "$make_thumbnails" -eq 1 ]; then
  common+=(--thumbnails "$thumbnails")
else
  common+=(--no-thumbnails)
fi
if [ "$force" -eq 1 ]; then
  common+=(--force)
fi

total_meshes=0
total_skipped=0
total_errors=0
failed=0

for n in 1 2 3 4; do
  root="${KOBAEDIT_ROOT:-$HOME/Desktop}/KOBAedit$n"
  if [ ! -d "$root" ]; then
    echo "skip KOBAedit$n: $root not found" >&2
    failed=$((failed + 1))
    continue
  fi
  echo "indexing KOBAedit$n ($root)…"
  set +e
  report="$(python3 "$repo_root/engine/scripts/ingest_assets.py" "$root" \
    --pack-name "kobaedit$n" "${common[@]}" 2>&1)"
  status=$?
  set -e
  if [ "$status" -ne 0 ]; then
    echo "KOBAedit$n failed:" >&2
    echo "$report" >&2
    failed=$((failed + 1))
    continue
  fi
  echo "$report" | python3 -c '
import json, sys
r = json.load(sys.stdin)
print(f"  meshes={r.get(\"meshes\", 0)} skipped={r.get(\"skipped\", 0)} errors={len(r.get(\"errors\", []))} in {r.get(\"durationMs\", 0)}ms")
' || echo "$report"
  total_meshes=$((total_meshes + $(echo "$report" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("meshes",0))' 2>/dev/null || echo 0)))
done

echo "done: indexed $total_meshes meshes into $db"
if [ "$failed" -ne 0 ]; then
  echo "$failed folder(s) could not be indexed" >&2
  exit 1
fi
