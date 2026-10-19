#!/usr/bin/env bash
# Downloads SRTM1 (30m resolution) elevation tiles for Germany and Netherlands.
# Coverage: lat 49–52 N, lon 3–10 E — 32 tiles × ~25 MB = ~800 MB total.
# Source: AWS terrain tiles (elevation-tiles-prod, public, no auth required).
#         Format: gzipped HGT (1-arc-second, compatible with opentopodata).
#
# Usage:
#   bash infra/opentopodata/download-srtm.sh
#
# Tiles land in infra/opentopodata/data/srtm/ and are mounted read-only
# into the tesla-opentopodata container on next start.

set -euo pipefail

DEST="$(cd "$(dirname "$0")" && pwd)/data/srtm"
BASE_URL="https://s3.amazonaws.com/elevation-tiles-prod/skadi"

mkdir -p "$DEST"

downloaded=0
skipped=0
failed=0

for lat in 49 50 51 52; do
  for lon in 3 4 5 6 7 8 9 10; do
    LAT_STR=$(printf "%02d" "$lat")
    LON_STR=$(printf "%03d" "$lon")
    FILE="N${LAT_STR}E${LON_STR}.hgt"
    DIR="N${LAT_STR}"

    if [[ -f "$DEST/$FILE" ]]; then
      echo "  skip  $FILE (already exists)"
      ((skipped++)) || true
      continue
    fi

    URL="${BASE_URL}/${DIR}/${FILE}.gz"
    echo "  fetch $FILE ..."
    if wget -q --timeout=60 --tries=3 "$URL" -O "$DEST/${FILE}.gz" 2>/dev/null; then
      gzip -d "$DEST/${FILE}.gz"
      if [[ -f "$DEST/$FILE" ]]; then
        ((downloaded++)) || true
      else
        echo "  warn  $FILE: gz downloaded but HGT missing"
        ((failed++)) || true
      fi
    else
      echo "  warn  $FILE: download failed"
      rm -f "$DEST/${FILE}.gz"
      ((failed++)) || true
    fi
  done
done

echo ""
echo "Done. downloaded=${downloaded}  skipped=${skipped}  failed=${failed}"
echo "HGT files in $DEST: $(ls "$DEST"/*.hgt 2>/dev/null | wc -l)"
du -sh "$DEST" 2>/dev/null || true
