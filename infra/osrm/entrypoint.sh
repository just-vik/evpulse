#!/bin/sh
# OSRM auto-setup entrypoint for EVPulse
# Downloads Hessen OSM data (~323 MB) and runs the map-matching server.
set -e

DATA_DIR="/data"
OSM_URL="https://download.geofabrik.de/europe/germany/hessen-latest.osm.pbf"
OSM_FILE="$DATA_DIR/hessen-latest.osm.pbf"
OSRM_FILE="$DATA_DIR/hessen-latest.osrm"
PROFILE="/usr/local/share/osrm/profiles/car.lua"

if [ ! -f "$OSRM_FILE" ]; then
  echo "[OSRM] First run — downloading and processing Hessen OSM data..."

  # Remove any stale/partial download before starting fresh
  rm -f "$OSM_FILE"

  echo "[OSRM] Downloading $OSM_URL (~323 MB)..."
  wget -O "$OSM_FILE" "$OSM_URL"
  echo "[OSRM] Download complete."

  echo "[OSRM] Extracting road network ..."
  osrm-extract -p "$PROFILE" "$OSM_FILE"

  # Remove raw OSM file after extraction to save disk space
  rm -f "$OSM_FILE"

  echo "[OSRM] Partitioning (MLD) ..."
  osrm-partition "$OSRM_FILE"

  echo "[OSRM] Customizing ..."
  osrm-customize "$OSRM_FILE"

  echo "[OSRM] Preprocessing done."
fi

echo "[OSRM] Starting server on port 5000 ..."
exec osrm-routed \
  --algorithm mld \
  --max-matching-size 500 \
  --port 5000 \
  --ip 0.0.0.0 \
  "$OSRM_FILE"
