#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# EVPulse iOS setup — Expo Go (local dev) and TestFlight (EAS build)
# ──────────────────────────────────────────────────────────────────────────────
set -e
cd "$(dirname "$0")"

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║       EVPulse iOS Setup                      ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

MODE=${1:-help}

case "$MODE" in

  # ── 1. EXPO GO (LAN — phone and server on same WiFi) ──────────────────────
  go)
    LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || ip route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')
    echo "▶ Starting dev server (Expo Go, LAN mode)..."
    echo ""
    echo "  Requirements:"
    echo "  • iPhone and this machine must be on the SAME WiFi network"
    echo "  • Expo Go installed on iPhone (App Store, free)"
    echo ""
    echo "  After Metro starts, open Expo Go → enter URL manually:"
    echo "  exp://${LAN_IP}:8081"
    echo ""
    echo "  Or in the Expo Go app: tap the search bar → type exp://${LAN_IP}:8081"
    echo ""
    /home/vik/tesla-platform/node_modules/.bin/expo start --lan
    ;;

  # ── 1b. EXPO GO (tunnel — any network, slower) ─────────────────────────────
  go-tunnel)
    echo "▶ Starting dev server (Expo Go, tunnel mode — works on any network)..."
    echo "  Scan the QR code in Expo Go."
    echo ""
    export PATH="$HOME/.npm-global/lib/node_modules/@expo/ngrok/node_modules/.bin:$PATH"
    /home/vik/tesla-platform/node_modules/.bin/expo start --tunnel
    ;;

  # ── 2. EAS INIT (do this once) ─────────────────────────────────────────────
  init)
    echo "▶ Initialising EAS project (one-time setup)..."
    echo ""
    echo "  Requirements:"
    echo "  • Expo account at https://expo.dev (free)"
    echo "  • Apple Developer account (99 USD/year) for TestFlight"
    echo ""
    npx eas-cli login
    npx eas-cli init
    echo ""
    echo "  ✓ Copy the projectId printed above into app.json → extra.eas.projectId"
    ;;

  # ── 3. TESTFLIGHT BUILD ────────────────────────────────────────────────────
  # Builds a production IPA and submits it to App Store Connect → TestFlight.
  # You'll be prompted for your Apple ID credentials on first run (stored in EAS).
  testflight)
    echo "▶ Building for TestFlight..."
    echo ""
    # Verify projectId is set
    if grep -q "REPLACE_WITH_EAS_PROJECT_ID" app.json; then
      echo "  ✗ ERROR: Replace 'REPLACE_WITH_EAS_PROJECT_ID' in app.json first."
      echo "         Run:  bash setup-ios.sh init"
      exit 1
    fi
    echo "  Building production IPA (takes ~15 min on EAS servers)..."
    npx eas-cli build --platform ios --profile production --auto-submit
    echo ""
    echo "  ✓ Build submitted. Open App Store Connect → TestFlight to distribute."
    echo "    https://appstoreconnect.apple.com"
    ;;

  # ── 4. PREVIEW BUILD (ad-hoc, no App Store) ──────────────────────────────
  # Installs directly on registered devices via URL (no TestFlight needed).
  # Good for sharing with a small team before App Store submission.
  preview)
    echo "▶ Building preview IPA (internal distribution)..."
    npx eas-cli build --platform ios --profile preview
    echo ""
    echo "  ✓ Done. Scan the QR / open the install URL from the EAS dashboard."
    ;;

  *)
    echo "Usage: bash setup-ios.sh <command>"
    echo ""
    echo "Commands:"
    echo "  go          Start Expo Go dev server (no account needed)"
    echo "  init        One-time EAS + Apple account setup"
    echo "  testflight  Build + submit to TestFlight (requires init first)"
    echo "  preview     Build ad-hoc IPA (internal devices, no App Store)"
    echo ""
    echo "Quick start (Expo Go):"
    echo "  1. Install 'Expo Go' from the App Store on your iPhone"
    echo "  2. cd apps/mobile && bash setup-ios.sh go"
    echo "  3. Scan the QR code"
    echo ""
    echo "TestFlight:"
    echo "  1. bash setup-ios.sh init"
    echo "  2. Fill in projectId in app.json"
    echo "  3. bash setup-ios.sh testflight"
    ;;
esac
