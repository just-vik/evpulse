#!/bin/bash
# Tesla Platform - Quick Setup Script
# Generates encryption keys and configures environment

echo "🚗 Tesla Platform - Quick Setup"
echo "================================"
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js first."
    exit 1
fi

# Check if we're in the backend directory
if [ ! -f "package.json" ]; then
    echo "❌ package.json not found. Please run this script from the backend directory."
    exit 1
fi

echo "1️⃣  Generating Tesla encryption keys..."
KEYS=$(node -e "
const crypto = require('crypto');
const key = crypto.randomBytes(32).toString('hex');
const iv = crypto.randomBytes(16).toString('hex');
console.log(key + '\n' + iv);
")

KEY=$(echo "$KEYS" | head -1)
IV=$(echo "$KEYS" | tail -1)

echo "✅ Generated encryption keys (save these to .env):"
echo ""
echo "TESLA_ENCRYPTION_KEY=$KEY"
echo "TESLA_ENCRYPTION_IV=$IV"
echo ""

# Check if .env exists
if [ ! -f ".env" ]; then
    echo "2️⃣  Creating .env file from .env.example..."
    cp .env.example .env
    echo "✅ Created .env file (update with your values)"
else
    echo "2️⃣  .env file already exists"
fi

echo ""
echo "3️⃣  Next steps:"
echo ""
echo "   a) Go to https://developer.tesla.com and register your OAuth app"
echo "      - Name: 'EV Analytics'"
echo "      - Redirect URI: http://localhost:4000/auth/tesla/callback"
echo "      - Scopes: All (vehicle_device_data, vehicle_commands, etc)"
echo ""
echo "   b) Update .env with:"
echo "      TESLA_CLIENT_ID=<your_client_id>"
echo "      TESLA_CLIENT_SECRET=<your_client_secret>"
echo "      TESLA_ENCRYPTION_KEY=$KEY"
echo "      TESLA_ENCRYPTION_IV=$IV"
echo ""
echo "   c) Run database migrations:"
echo "      npx prisma migrate dev --name tesla_integration"
echo ""
echo "   d) Start development server:"
echo "      npm run start:dev"
echo ""
echo "✨ Setup complete! Visit http://localhost:4000/auth/tesla/login to test OAuth"
