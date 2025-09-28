#!/bin/bash

# Nautica gRPC Deployment Script
set -e

echo "🚀 Deploying Nautica gRPC Worker..."

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if wrangler is installed
if ! command -v wrangler &> /dev/null; then
    echo -e "${RED}Error: wrangler is not installed. Please install it first.${NC}"
    echo "npm install -g wrangler"
    exit 1
fi

# Check if logged in to Cloudflare
if ! wrangler whoami &> /dev/null; then
    echo -e "${YELLOW}Please login to Cloudflare first:${NC}"
    wrangler login
fi

# Check environment
ENV=${1:-development}
echo -e "${GREEN}Deploying to environment: $ENV${NC}"

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Build (if needed)
echo "🔨 Building..."
npm run build

# Deploy
echo "🚀 Deploying to Cloudflare Workers..."
wrangler deploy --env $ENV

echo -e "${GREEN}✅ Deployment complete!${NC}"
echo ""
echo "Worker URLs:"
echo "Development: https://nautica-grpc-dev.your-subdomain.workers.dev"
echo "Staging: https://nautica-grpc-staging.your-subdomain.workers.dev"
echo "Production: https://nautica-grpc-prod.your-subdomain.workers.dev"
echo ""
echo "gRPC Endpoints:"
echo "  HealthCheck: /nautica.NauticaProxy/HealthCheck"
echo "  CreateTCPStream: /nautica.NauticaProxy/CreateTCPStream"
echo "  CreateUDPStream: /nautica.NauticaProxy/CreateUDPStream"
echo "  GetProxyConfig: /nautica.NauticaProxy/GetProxyConfig"