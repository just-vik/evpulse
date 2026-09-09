#!/usr/bin/env bash
# ============================================================
# EVPulse — Self-hosted web basemap (PMTiles) build
#
# Produces the regional PMTiles vector-tile archive that
# apps/web's trip maps (TripMapGL, TripReplay) read directly via
# HTTP range requests — no tile server, no API key, no
# third-party account. Replaces the old CARTO raster CDN, which
# started requiring an API key and serving "API KEY REQUIRED"
# watermark tiles in production.
#
# The output file is NOT committed to git (apps/web/public/maps/
# is gitignored, ~1.1 GB) — this script must be re-run after a
# fresh clone, or whenever the covered region needs to change.
#
# Usage:
#   scripts/build-basemap-tiles.sh
#
# Adjust BBOX below to widen/narrow coverage. Default covers
# Hesse + a generous buffer into neighboring states (NRW-south,
# Rheinland-Pfalz, northern Baden-Württemberg) — ~1.1 GB at
# maxzoom 14. Full Germany at the same maxzoom is ~3.4 GB.
# ============================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$REPO_ROOT/apps/web/public/maps"
OUT_FILE="$OUT_DIR/region.pmtiles"
PMTILES_BIN="$REPO_ROOT/.tools/pmtiles"

# min_lon,min_lat,max_lon,max_lat — WGS84
BBOX="6.0,48.5,11.0,52.0"
MAXZOOM=14

# Protomaps publishes a fresh planet-wide PMTiles build daily at
# build.protomaps.com/YYYYMMDD.pmtiles. `pmtiles extract` reads only the
# tiles inside BBOX from that *remote* file via HTTP range requests — it
# never downloads the whole planet.
find_latest_build() {
  for i in $(seq 0 10); do
    local d
    d=$(date -u -d "-${i} day" +%Y%m%d 2>/dev/null || date -u -v-"${i}"d +%Y%m%d)
    local url="https://build.protomaps.com/${d}.pmtiles"
    if curl -s -o /dev/null -w '%{http_code}' --max-time 8 "$url" | grep -q '^200$'; then
      echo "$url"
      return 0
    fi
  done
  echo "Could not find a recent Protomaps daily build (tried last 10 days)." >&2
  exit 1
}

mkdir -p "$OUT_DIR" "$(dirname "$PMTILES_BIN")"

if [ ! -x "$PMTILES_BIN" ]; then
  echo "Downloading pmtiles CLI..."
  ARCH="$(uname -m)"
  OS="$(uname -s)"
  case "${OS}_${ARCH}" in
    Linux_x86_64)  ASSET="go-pmtiles_1.31.2_Linux_x86_64.tar.gz" ;;
    Linux_aarch64) ASSET="go-pmtiles_1.31.2_Linux_arm64.tar.gz" ;;
    Darwin_arm64)  ASSET="go-pmtiles-1.31.2_Darwin_arm64.zip" ;;
    Darwin_x86_64) ASSET="go-pmtiles-1.31.2_Darwin_x86_64.zip" ;;
    *) echo "Unsupported platform ${OS}_${ARCH} — download pmtiles manually from https://github.com/protomaps/go-pmtiles/releases and place it at $PMTILES_BIN" >&2; exit 1 ;;
  esac
  TMP="$(mktemp -d)"
  curl -sL -o "$TMP/asset" "https://github.com/protomaps/go-pmtiles/releases/download/v1.31.2/${ASSET}"
  case "$ASSET" in
    *.tar.gz) tar xzf "$TMP/asset" -C "$TMP" ;;
    *.zip)    unzip -q "$TMP/asset" -d "$TMP" ;;
  esac
  mv "$TMP/pmtiles" "$PMTILES_BIN"
  chmod +x "$PMTILES_BIN"
  rm -rf "$TMP"
fi

BUILD_URL="$(find_latest_build)"
echo "Using Protomaps build: $BUILD_URL"
echo "Extracting bbox=$BBOX maxzoom=$MAXZOOM -> $OUT_FILE"

"$PMTILES_BIN" extract "$BUILD_URL" "$OUT_FILE" --bbox="$BBOX" --maxzoom="$MAXZOOM"

echo "Done: $OUT_FILE ($(du -h "$OUT_FILE" | cut -f1))"
echo "Fonts/sprites are already committed under apps/web/public/{fonts,sprites} — nothing else to fetch."
