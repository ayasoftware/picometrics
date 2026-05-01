#!/bin/bash
set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────
RESOURCE_GROUP="marketing-ai-rg"
VM_NAME="marketing-ai-vm"
LOCATION="eastus"
VM_SIZE="Standard_B4ms"
ADMIN_USER="azureuser"
SSH_KEY="$HOME/.ssh/id_rsa"
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TARBALL="/tmp/marketing-ai-platform.tar.gz"

# ── Step 1: Resource group ────────────────────────────────────────────
echo "==> Creating resource group: $RESOURCE_GROUP"
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" -o table

# ── Step 2: Create VM ─────────────────────────────────────────────────
# Use full image URN — az vm create alias resolution fails in some environments
echo "==> Creating VM: $VM_NAME ($VM_SIZE)"
az vm create \
  --resource-group "$RESOURCE_GROUP" \
  --name "$VM_NAME" \
  --image "Canonical:0001-com-ubuntu-server-jammy:22_04-lts-gen2:latest" \
  --size "$VM_SIZE" \
  --admin-username "$ADMIN_USER" \
  --generate-ssh-keys \
  --public-ip-sku Standard \
  --output table

# ── Step 3: Open ports ────────────────────────────────────────────────
echo "==> Opening ports 80 and 443"
az vm open-port --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" --port 80  --priority 1010 -o none
az vm open-port --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" --port 443 --priority 1020 -o none

# ── Step 4: Get public IP ─────────────────────────────────────────────
PUBLIC_IP=$(az vm show -d --resource-group "$RESOURCE_GROUP" --name "$VM_NAME" --query publicIps -o tsv)
echo "==> VM public IP: $PUBLIC_IP"

SSH_OPTS="-i $SSH_KEY -o StrictHostKeyChecking=no -o ConnectTimeout=10"

# ── Step 5: Wait for SSH and install Docker ───────────────────────────
echo "==> Waiting for SSH to be ready (up to 2 min)..."
for i in $(seq 1 24); do
  if ssh $SSH_OPTS "$ADMIN_USER@$PUBLIC_IP" "echo ok" 2>/dev/null; then
    echo "    SSH is ready."
    break
  fi
  echo "    Attempt $i/24 — waiting 5s..."
  sleep 5
done

echo "==> Installing Docker and adding 4GB swap..."
ssh $SSH_OPTS "$ADMIN_USER@$PUBLIC_IP" bash << 'SETUP'
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
# Swap helps during parallel image pulls
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
SETUP
echo "    Docker installed."

# ── Step 6: Package and upload project ───────────────────────────────
echo "==> Packaging project (excluding node_modules, .git)..."
tar -czf "$TARBALL" \
  --exclude="*/node_modules" \
  --exclude="*/.git" \
  --exclude="*/dist" \
  --exclude="*/.turbo" \
  --exclude="*/.env" \
  -C "$(dirname "$PROJECT_DIR")" \
  "$(basename "$PROJECT_DIR")"

echo "==> Uploading to VM..."
scp $SSH_OPTS "$TARBALL" "$ADMIN_USER@$PUBLIC_IP:~/"
rm -f "$TARBALL"

# ── Step 7: Deploy on VM ──────────────────────────────────────────────
echo "==> Deploying on VM..."
ssh $SSH_OPTS "$ADMIN_USER@$PUBLIC_IP" bash << REMOTE
set -euo pipefail

echo "--> Extracting project..."
tar -xzf ~/marketing-ai-platform.tar.gz -C ~/
cd ~/marketing-ai-platform

echo "--> Configuring .env for production..."
sed -i "s|OAUTH_REDIRECT_BASE_URL=.*|OAUTH_REDIRECT_BASE_URL=http://$PUBLIC_IP|" .env
sed -i "s|NODE_ENV=development|NODE_ENV=production|" .env

echo "--> Building services one at a time (esbuild, no OOM)..."
for svc in mcp-gtm mcp-google-ads mcp-linkedin-ads mcp-facebook-ads mcp-google-analytics backend; do
  echo "  Building \$svc..."
  sudo docker compose -f docker-compose.yml build "\$svc" 2>&1 | grep -E "Built|ERROR" | head -3
done

echo "--> Starting full stack..."
sudo docker compose -f docker-compose.yml up -d

echo "--> Waiting 90s for all healthchecks..."
sleep 90
sudo docker compose -f docker-compose.yml ps
REMOTE

# ── Done ──────────────────────────────────────────────────────────────
echo ""
echo "======================================================"
echo " Deployment complete!"
echo " Open WebUI : http://$PUBLIC_IP"
echo " Backend API: http://$PUBLIC_IP/api"
echo " Health     : http://$PUBLIC_IP/health"
echo "======================================================"
echo ""
echo "SSH logs:   ssh $ADMIN_USER@$PUBLIC_IP 'cd marketing-ai-platform && sudo docker compose -f docker-compose.yml logs -f'"
echo "SSH stop:   ssh $ADMIN_USER@$PUBLIC_IP 'cd marketing-ai-platform && sudo docker compose -f docker-compose.yml down'"
echo "Destroy VM: az group delete --name $RESOURCE_GROUP --yes --no-wait"
