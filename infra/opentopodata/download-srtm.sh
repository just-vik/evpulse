#!/usr/bin/env bash
# Downloads SRTM3 (90m resolution) elevation tiles for Germany and Netherlands.
# Coverage: lat 49–52 N, lon 3–10 E — 32 tiles, ~90 MB total.
# Source: NASA SRTM v2.1 via USGS (public domain, no registration required).
#
# Usage:
#   bash infra/opentopodata/download-srtm.sh
#
# Tiles land in infra/opentopodata/data/srtm/ and are mounted read-only
# into the tesla-opentopodata container on next start.

set -euo pipefail

DEST="$(cd "$(dirname "$0")" && pwd)/data/srtm"
BASE_URL="https://dds.cr.usgs.gov/srtm/version2_1/SRTM3/Eurasia"

mkdir -p "$DEST"

downloaded=0
skipped=0
failed=0

for lat in 49 50 51 52; do
  for lon in 3 4 5 6 7 8 9 10; do
    LAT_STR=$(printf "%02d" "$lat")
    LON_STR=$(printf "%03d" "$lon")
    FILE="N${LAT_STR}E${LON_STR}.hgt"

    if [[ -f "$DEST/$FILE" ]]; then
      echo "  skip  $FILE (already exists)"
      ((skipped++)) || true
      continue
    fi

    URL="${BASE_URL}/${FILE}.zip"
    echo "  fetch $FILE ..."
    if wget -q --timeout=30 --tries=3 "$URL" -O "$DEST/${FILE}.zip" 2>/dev/null; then
      unzip -q -o "$DEST/${FILE}.zip" -d "$DEST/" 2>/dev/null || true
      rm -f "$DEST/${FILE}.zip"
      if [[ -f "$DEST/$FILE" ]]; then
        ((downloaded++)) || true
      else
        echo "  warn  $FILE: zip downloaded but HGT missing (tile may be ocean)"
        ((failed++)) || true
      fi
    else
      echo "  warn  $FILE: download failed (ocean tile or server unavailable)"
      rm -f "$DEST/${FILE}.zip"
      ((failed++)) || true
    fi
  done
done

echo ""
echo "Done. downloaded=${downloaded}  skipped=${skipped}  failed/ocean=${failed}"
echo "HGT files in $DEST:"
ls "$DEST"/*.hgt 2>/dev/null | wc -l
