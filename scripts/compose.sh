#!/usr/bin/env bash
set -euo pipefail
exec docker compose --env-file ./secrets/.env "$@"
