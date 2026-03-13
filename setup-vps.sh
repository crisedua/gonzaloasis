#!/usr/bin/env bash
# ─── VPS Setup Script ─────────────────────────────────────────────────────────
# Run on a fresh Hostinger VPS with Claude CLI already installed.
#
# Usage:
#   git clone https://github.com/crisedua/miasistente.git ~/second-brain
#   cd ~/second-brain
#   chmod +x setup-vps.sh
#   ./setup-vps.sh
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

echo "── Checking prerequisites ──"

# Node.js
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js not found. Install it first:"
  echo "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
  echo "  sudo apt-get install -y nodejs"
  exit 1
fi
echo "Node.js $(node --version)"

# Claude CLI
if ! command -v claude &>/dev/null; then
  echo "ERROR: Claude CLI not found. Install it first:"
  echo "  npm install -g @anthropic-ai/claude-code"
  exit 1
fi
echo "Claude CLI $(claude --version 2>/dev/null || echo 'installed')"

# PM2
if ! command -v pm2 &>/dev/null; then
  echo "Installing PM2..."
  sudo npm install -g pm2
fi
echo "PM2 $(pm2 --version)"

echo ""
echo "── Installing dependencies ──"
npm install --production

echo ""
echo "── Creating directories ──"
mkdir -p logs memory documents

echo ""
echo "── Building memory index ──"
node memory_manager.mjs index || echo "(No memory files to index yet — that's fine)"

echo ""
echo "── Checking .env ──"
if [ ! -f .env ]; then
  cp .env.example .env
  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║  .env created from .env.example                            ║"
  echo "║  You MUST edit it before starting the bot:                  ║"
  echo "║                                                             ║"
  echo "║    nano .env                                                ║"
  echo "║                                                             ║"
  echo "║  Required:                                                  ║"
  echo "║    TELEGRAM_BOT_TOKEN=...                                   ║"
  echo "║    ALLOWED_TELEGRAM_USER_ID=...                             ║"
  echo "║                                                             ║"
  echo "║  Then start the bot:                                        ║"
  echo "║    pm2 start ecosystem.config.cjs                           ║"
  echo "║    pm2 startup && pm2 save                                  ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
else
  echo ".env already exists — skipping."
  echo ""
  echo "── Starting bot with PM2 ──"
  pm2 start ecosystem.config.cjs
  pm2 save

  echo ""
  echo "── Setting up PM2 to survive reboots ──"
  pm2 startup || echo "(Run the command PM2 suggests above with sudo)"
  pm2 save

  echo ""
  echo "╔══════════════════════════════════════════════════════════════╗"
  echo "║  Bot is running! Test it:                                   ║"
  echo "║    pm2 logs second-brain --lines 20                         ║"
  echo "║    → then send /start to your bot on Telegram               ║"
  echo "╚══════════════════════════════════════════════════════════════╝"
fi
