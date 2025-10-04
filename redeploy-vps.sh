#!/bin/bash
# Quick redeploy script for VPS updates

echo "🔄 Pulling latest changes..."
git pull origin main

echo "📦 Installing dependencies..."
npm ci

echo "🔨 Building TypeScript..."
npm run build

echo "🔄 Restarting PM2..."
pm2 restart lawyer-backend

echo "✅ Deployment complete!"
echo "📊 Check status:"
pm2 logs lawyer-backend --lines 20
