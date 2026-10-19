#!/usr/bin/env bash
# Palette guard: fail if any deprecated Phase 9 / pre-Phase 10 ROVIQEN colors
# are found in the web app source.
#
# Deprecated:
#   #43D1AD  (old Signal Teal) → use #34B49C
#   #C2F54A  (old Volt Lime)   → use #A4D438
#
# Run: bash scripts/check-palette.sh
# Or via npm (in apps/web): npm run check-palette

set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)/apps/web/src"
PUBLIC_DIR="$(cd "$(dirname "$0")/.." && pwd)/apps/web/public"

PATTERNS='#43D1AD|#C2F54A|rgba\(67,209,173,'
EXTENSIONS='--include=*.tsx --include=*.ts --include=*.css --include=*.json'

HITS=$(grep -rn -E "$PATTERNS" $EXTENSIONS "$SRC_DIR" "$PUBLIC_DIR" 2>/dev/null || true)

if [ -n "$HITS" ]; then
  echo "❌ Deprecated palette colors found. Replace with ROVIQEN Phase 11 values:"
  echo "   #43D1AD → #34B49C  (Signal Teal)"
  echo "   #C2F54A → #A4D438  (Volt Lime)"
  echo ""
  echo "$HITS"
  exit 1
fi

echo "✅ Palette check passed — no deprecated colors in source."
