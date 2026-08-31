#!/bin/sh
set -e

TEMPLATE=/config/server.json.template
OUTPUT=/tmp/server.json

if [ -z "$FLEET_INTERNAL_TOKEN" ]; then
  echo "ERROR: FLEET_INTERNAL_TOKEN is not set" >&2
  exit 1
fi

envsubst < "$TEMPLATE" > "$OUTPUT"
echo "Fleet Telemetry config written to $OUTPUT"

exec /usr/local/bin/fleet-telemetry -config "$OUTPUT"
