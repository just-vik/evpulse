#!/usr/bin/env bash
# ============================================================
# EVPulse — Fleet Telemetry Setup
#
# Run ONCE to enable real-time streaming telemetry from Tesla.
# After this, vehicles push data every 10 s instead of polling.
#
# Prerequisites:
#   1. DNS: telemetry.evpulse.app → <this server IP>
#          Cloudflare proxy MUST be DISABLED (grey cloud icon)
#          so Tesla can connect via raw TCP/TLS (not HTTP proxy).
#
#   2. Firewall: port 443 open inbound (Tesla vehicle → server)
#          sudo ufw allow 443/tcp    # if ufw
#          sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
#
# Usage:
#   chmod +x scripts/setup-fleet-telemetry.sh
#   sudo ./scripts/setup-fleet-telemetry.sh
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLATFORM_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PLATFORM_DIR/secrets/.env"
CERTS_DIR="$PLATFORM_DIR/secrets/fleet-telemetry-certs"

HOSTNAME="${FLEET_TELEMETRY_HOSTNAME:-telemetry.evpulse.app}"
EMAIL="${CERTBOT_EMAIL:-admin@evpulse.app}"

echo "═══════════════════════════════════════════════"
echo " EVPulse Fleet Telemetry Setup"
echo " Domain : $HOSTNAME"
echo " Email  : $EMAIL"
echo "═══════════════════════════════════════════════"

# ── Step 1: TLS certificate via Let's Encrypt ──────────────
echo ""
echo "▶ Step 1: Obtaining TLS certificate for $HOSTNAME..."

if ! command -v certbot &>/dev/null; then
  echo "Installing certbot..."
  apt-get update -q && apt-get install -y -q certbot python3-certbot-dns-cloudflare
elif ! python3 -c "import certbot_dns_cloudflare" 2>/dev/null; then
  apt-get install -y -q python3-certbot-dns-cloudflare
fi

# DNS-01 challenge via Cloudflare API — does NOT require port 80 to be open.
# Get your Cloudflare API Token:
#   Cloudflare Dashboard → My Profile → API Tokens → Create Token
#   Template: "Edit zone DNS" → Zone: evpulse.app → Create Token → Copy
CF_CREDS_FILE="$PLATFORM_DIR/secrets/cloudflare.ini"

if [ -z "${CF_API_TOKEN:-}" ] && [ ! -f "$CF_CREDS_FILE" ]; then
  echo ""
  echo "  ERROR: Cloudflare API token required for DNS challenge."
  echo "  Port 80 is blocked by Deutsche Telekom — HTTP challenge won't work."
  echo ""
  echo "  1. Go to: https://dash.cloudflare.com/profile/api-tokens"
  echo "  2. Create Token → 'Edit zone DNS' → Zone: evpulse.app"
  echo "  3. Run again with:"
  echo "     CF_API_TOKEN=your_token sudo -E ./scripts/setup-fleet-telemetry.sh"
  exit 1
fi

if [ -n "${CF_API_TOKEN:-}" ]; then
  cat > "$CF_CREDS_FILE" << EOF
dns_cloudflare_api_token = ${CF_API_TOKEN}
EOF
  chmod 600 "$CF_CREDS_FILE"
fi

certbot certonly \
  --dns-cloudflare \
  --dns-cloudflare-credentials "$CF_CREDS_FILE" \
  --non-interactive \
  --agree-tos \
  --email "$EMAIL" \
  -d "$HOSTNAME"

mkdir -p "$CERTS_DIR"
cp /etc/letsencrypt/live/"$HOSTNAME"/fullchain.pem "$CERTS_DIR/fullchain.pem"
cp /etc/letsencrypt/live/"$HOSTNAME"/privkey.pem   "$CERTS_DIR/privkey.pem"
chmod 640 "$CERTS_DIR/privkey.pem"

echo "  ✓ Certs written to $CERTS_DIR"

# ── Step 2: Generate internal token ────────────────────────
echo ""
echo "▶ Step 2: Generating FLEET_INTERNAL_TOKEN..."

FLEET_INTERNAL_TOKEN=$(openssl rand -hex 32)

# Add or update in .env
if grep -q '^FLEET_INTERNAL_TOKEN=' "$ENV_FILE" 2>/dev/null; then
  sed -i "s|^FLEET_INTERNAL_TOKEN=.*|FLEET_INTERNAL_TOKEN=$FLEET_INTERNAL_TOKEN|" "$ENV_FILE"
else
  echo "FLEET_INTERNAL_TOKEN=$FLEET_INTERNAL_TOKEN" >> "$ENV_FILE"
fi

if grep -q '^FLEET_TELEMETRY_HOSTNAME=' "$ENV_FILE" 2>/dev/null; then
  sed -i "s|^FLEET_TELEMETRY_HOSTNAME=.*|FLEET_TELEMETRY_HOSTNAME=$HOSTNAME|" "$ENV_FILE"
else
  echo "FLEET_TELEMETRY_HOSTNAME=$HOSTNAME" >> "$ENV_FILE"
fi

echo "  ✓ Token written to secrets/.env"

# ── Step 3: Build and start fleet-telemetry container ──────
echo ""
echo "▶ Step 3: Building and starting tesla-fleet-telemetry..."

cd "$PLATFORM_DIR"
docker compose build fleet-telemetry
docker compose --profile fleet-telemetry up -d fleet-telemetry

echo "  ✓ Container started"

# ── Step 4: TLS renewal cron ───────────────────────────────
echo ""
echo "▶ Step 4: Setting up certificate auto-renewal..."

CRON_CMD="0 3 1 * * certbot renew --quiet --dns-cloudflare --dns-cloudflare-credentials $CF_CREDS_FILE && cp /etc/letsencrypt/live/$HOSTNAME/fullchain.pem $CERTS_DIR/fullchain.pem && cp /etc/letsencrypt/live/$HOSTNAME/privkey.pem $CERTS_DIR/privkey.pem && docker restart tesla-fleet-telemetry"
( crontab -l 2>/dev/null | grep -v 'fleet-telemetry'; echo "$CRON_CMD" ) | crontab -

echo "  ✓ Monthly renewal cron added"

# ── Step 5: Register config with Tesla vehicle ─────────────
echo ""
echo "▶ Step 5: Registering fleet_telemetry_config with Tesla..."

METRICS_SECRET=$(grep '^METRICS_SECRET=' "$ENV_FILE" | cut -d= -f2)
if [ -n "$METRICS_SECRET" ] && [ "$METRICS_SECRET" != "change-me" ]; then
  sleep 5 # wait for api restart
  RESULT=$(curl -s -X POST http://localhost:3000/api/v1/auth/tesla/admin-configure-telemetry \
    -H "x-metrics-secret: $METRICS_SECRET" \
    -H "Content-Type: application/json")
  echo "  Tesla API response: $RESULT"
  if echo "$RESULT" | grep -q '"ok":true'; then
    echo "  ✓ fleet_telemetry_config sent to vehicle"
  else
    echo "  ⚠ Config send failed — check API logs or send manually:"
    echo "    curl -X POST http://localhost:3000/api/v1/auth/tesla/admin-configure-telemetry \\"
    echo "      -H 'x-metrics-secret: $METRICS_SECRET'"
  fi
else
  echo "  ⚠ METRICS_SECRET not set — send config manually after setting it:"
  echo "    curl -X POST http://localhost:3000/api/v1/auth/tesla/admin-configure-telemetry \\"
  echo "      -H 'x-metrics-secret: YOUR_METRICS_SECRET'"
fi
echo ""
echo "═══════════════════════════════════════════════"
echo " ✅ Fleet Telemetry setup complete!"
echo ""
echo " Verify with:"
echo "   docker logs tesla-fleet-telemetry --tail 20"
echo "   openssl s_client -connect $HOSTNAME:443 -brief"
echo "═══════════════════════════════════════════════"
