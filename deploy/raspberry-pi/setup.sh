#!/usr/bin/env bash
# Turns a Raspberry Pi (Raspberry Pi OS Bookworm, 64-bit) into a SpirChat hub:
#   - open Wi-Fi access point "SpirChat-<name>" on wlan0
#   - every DNS name resolves to the hub, so phones show the app as a captive portal
#   - the hub runs on port 80 as a systemd service and starts on boot
#
# Run from the repository root, while the Pi still has internet (to install Node):
#   sudo HUB_NAME=Karrada-1 ./deploy/raspberry-pi/setup.sh
set -euo pipefail

HUB_NAME="${HUB_NAME:-SpirChat}"
# Every hub uses the same network name, so a phone that joined one hub joins any other
# automatically: messages it carries are delivered as soon as its owner walks past.
SSID="${SSID:-SpirChat}"
WIFI_IF="${WIFI_IF:-wlan0}"
HUB_IP="${HUB_IP:-10.42.0.1}"
CHANNEL="${CHANNEL:-6}"
PEERS="${PEERS:-}"
ALERT_KEYS="${ALERT_KEYS:-}"
APP_DIR="/opt/spirchat"
DATA_DIR="/var/lib/spirchat"

if [[ $EUID -ne 0 ]]; then
  echo "run with sudo" >&2
  exit 1
fi

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

echo "==> Installing Node.js 22"
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]]; then
  apt-get update
  apt-get install -y ca-certificates curl gnupg
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "==> Building SpirChat into ${APP_DIR}"
rsync -a --delete --exclude node_modules --exclude .git --exclude data "${REPO_DIR}/" "${APP_DIR}/"
cd "${APP_DIR}"
npm ci
npm run build
npm prune --omit=dev
id spirchat >/dev/null 2>&1 || useradd --system --home "${DATA_DIR}" --shell /usr/sbin/nologin spirchat
mkdir -p "${DATA_DIR}"
chown -R spirchat:spirchat "${DATA_DIR}"

echo "==> Configuring Wi-Fi access point ${SSID} on ${WIFI_IF}"
nmcli connection delete spirchat-ap >/dev/null 2>&1 || true
nmcli connection add type wifi ifname "${WIFI_IF}" con-name spirchat-ap autoconnect yes ssid "${SSID}" \
  802-11-wireless.mode ap 802-11-wireless.band bg 802-11-wireless.channel "${CHANNEL}" \
  ipv4.method shared ipv4.addresses "${HUB_IP}/24" ipv6.method disabled
# NetworkManager's shared mode runs dnsmasq; answer every DNS query with the hub's address.
mkdir -p /etc/NetworkManager/dnsmasq-shared.d
cat >/etc/NetworkManager/dnsmasq-shared.d/spirchat.conf <<EOF
address=/#/${HUB_IP}
EOF

echo "==> Installing systemd service"
sed -e "s|@APP_DIR@|${APP_DIR}|g" -e "s|@DATA_DIR@|${DATA_DIR}|g" \
  -e "s|@HUB_NAME@|${HUB_NAME}|g" -e "s|@PEERS@|${PEERS}|g" -e "s|@ALERT_KEYS@|${ALERT_KEYS}|g" \
  "${REPO_DIR}/deploy/raspberry-pi/spirchat-hub.service" >/etc/systemd/system/spirchat-hub.service
systemctl daemon-reload
systemctl enable --now spirchat-hub
nmcli connection up spirchat-ap

echo
echo "Done. Connect a phone to Wi-Fi \"${SSID}\" and the app should open automatically."
echo "If it does not, open http://${HUB_IP}/ in the browser."
echo "Logs: journalctl -u spirchat-hub -f"
