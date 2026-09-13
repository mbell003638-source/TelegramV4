#!/usr/bin/env bash
# =============================================================================
#  scripts/deploy-vps.sh — Production Deployment for 32 GB RAM Cloud VPS
#  Target OS: Ubuntu 22.04 / 24.04 LTS (x86_64 or aarch64)
# =============================================================================

set -e

echo "=========================================================="
echo "🚀 ClaudeClaw Master 32GB VPS Deployer"
echo "=========================================================="

if [ "$EUID" -ne 0 ]; then
  echo "❌ Please run as root: sudo bash deploy-vps.sh"
  exit 1
fi

TOTAL_RAM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
TOTAL_RAM_GB=$((TOTAL_RAM_KB / 1024 / 1024))
echo "ℹ️ Detected Hardware: ${TOTAL_RAM_GB} GB RAM, $(nproc) CPU Cores"

# 1. Update system packages
echo "📦 Updating apt packages..."
apt update -y && apt upgrade -y
apt install -y curl wget git build-essential sqlite3 ca-certificates gnupg

# 2. Install Node.js 22 LTS (Native node:sqlite support)
if ! command -v node &> /dev/null || [ "$(node -v | cut -d'.' -f1 | tr -d 'v')" -lt 22 ]; then
    echo "📦 Installing Node.js 22 LTS..."
    mkdir -p /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg --yes
    NODE_MAJOR=22
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" | tee /etc/apt/sources.list.d/nodesource.list
    apt update -y
    apt install -y nodejs
fi

echo "✅ Node version: $(node -v)"
echo "✅ NPM version:  $(npm -v)"

# 3. Setup application directory
APP_DIR="/opt/claudeclaw"
mkdir -p "${APP_DIR}"
echo "📁 Setting up ${APP_DIR}..."

# Copy files from current directory
cp -r . "${APP_DIR}/" || true
cd "${APP_DIR}"

# 4. Install production dependencies
echo "📦 Installing Node dependencies..."
npm install --omit=dev

# 5. Setup environment file if not exists
if [ ! -f "${APP_DIR}/.env" ]; then
    echo "⚙️ Creating .env from template..."
    cp "${APP_DIR}/scripts/.env.vps.template" "${APP_DIR}/.env"
    echo "⚠️ NOTE: Edit ${APP_DIR}/.env with your TELEGRAM_BOT_TOKEN and ALLOWED_USER_ID!"
fi

# 6. Install systemd service
echo "🔧 Installing systemd service..."
cp "${APP_DIR}/scripts/claudeclaw.service" /etc/systemd/system/claudeclaw.service
systemctl daemon-reload
systemctl enable claudeclaw.service

# 7. Configure firewall (UFW)
if command -v ufw &> /dev/null; then
    echo "🛡️ Configuring firewall rules..."
    ufw allow 3141/tcp comment "ClaudeClaw Mission Control & Satellite Hub" || true
fi

echo "=========================================================="
echo "🎉 Deployment Setup Complete!"
echo "=========================================================="
echo "Next Steps:"
echo "1. Edit configuration: nano /opt/claudeclaw/.env"
echo "2. Start the master service: systemctl start claudeclaw"
echo "3. Check logs: journalctl -u claudeclaw -f"
echo "4. Mission Control Dashboard: http://YOUR_VPS_IP:3141/?token=YOUR_TOKEN"
echo "5. Connect your Windows machine:"
echo "   Run on Windows: node desktop-worker.js --url http://YOUR_VPS_IP:3141 --key YOUR_TOKEN"
echo "=========================================================="
