#!/bin/bash

# EVPulse - Database Migration & Setup Script
# Run this to initialize the production database

set -e

echo "🚀 EVPulse Tesla Analytics Platform - Setup"
echo "==========================================="

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check Node.js
echo -e "$BLUE[1/5] Checking Node.js installation...$NC"
if ! command -v node &> /dev/null; then
    echo "❌ Node.js not found. Please install Node.js 18+"
    exit 1
fi
NODE_VERSION=$(node -v)
echo -e "$GREEN✓ Node.js $NODE_VERSION$NC"

# Check dependencies
echo -e "$BLUE[2/5] Installing npm dependencies...$NC"
if [ ! -d "node_modules" ]; then
    npm install
    echo -e "$GREEN✓ Dependencies installed$NC"
else
    echo -e "$GREEN✓ Dependencies already installed$NC"
fi

# Check environment
echo -e "$BLUE[3/5] Checking environment configuration...$NC"
if [ ! -f ".env" ]; then
    if [ -f ".env.example" ]; then
        cp .env.example .env
        echo -e "$YELLOW⚠️  Created .env from .env.example$NC"
        echo -e "$YELLOW   Please update .env with your database credentials$NC"
    else
        echo "❌ .env file not found and .env.example not available"
        exit 1
    fi
fi
echo -e "$GREEN✓ Environment configured$NC"

# Generate Prisma Client
echo -e "$BLUE[4/5] Generating Prisma Client...$NC"
npm run prisma:generate
echo -e "$GREEN✓ Prisma Client generated$NC"

# Run migrations
echo -e "$BLUE[5/5] Running database migrations...$NC"
npm run prisma:migrate dev --name init
echo -e "$GREEN✓ Database migrations complete$NC"

echo ""
echo "==========================================="
echo -e "$GREEN✓ Setup complete!$NC"
echo "==========================================="
echo ""
echo "Next steps:"
echo "  1. Start the server:"
echo "     npm run start:dev"
echo ""
echo "  2. Open API documentation:"
echo "     http://localhost:3000/api/docs"
echo ""
echo "  3. Explore schema:"
echo "     npm run prisma:studio"
echo ""
echo "For more information, see:"
echo "  - QUICKSTART.md (5-minute setup guide)"
echo "  - ARCHITECTURE.md (architecture overview)"
echo "  - API_DOCUMENTATION.md (API reference)"
echo ""
