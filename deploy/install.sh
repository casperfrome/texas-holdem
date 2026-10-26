#!/usr/bin/env bash
set -euo pipefail
RELEASE=${1:?release directory required}
IP=${2:-156.225.76.31}
PORT=${3:-1108}
BASE=/opt/texas-holdem
[[ "$RELEASE" == "$BASE/releases/"* && -f "$RELEASE/package.json" ]] || { echo 'Invalid release directory'; exit 1; }
export DEBIAN_FRONTEND=noninteractive
if ! command -v nginx >/dev/null; then
  apt-get update -qq
  apt-get install -y nginx curl xz-utils ca-certificates
fi
if ! command -v node >/dev/null || [[ $(node -p 'process.versions.node.split(".")[0]') != 24 ]]; then
  NODE_TMP=$(mktemp -d)
  curl -fsSL https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o "$NODE_TMP/SHASUMS256.txt"
  ARCHIVE=$(awk '$2 ~ /^node-v24\.[0-9]+\.[0-9]+-linux-x64.tar.xz$/ {print $2; exit}' "$NODE_TMP/SHASUMS256.txt")
  [[ -n "$ARCHIVE" ]] || { echo 'Node 24 artifact missing'; exit 1; }
  curl -fsSL "https://nodejs.org/dist/latest-v24.x/$ARCHIVE" -o "$NODE_TMP/$ARCHIVE"
  (cd "$NODE_TMP"; awk -v file="$ARCHIVE" '$2 == file' SHASUMS256.txt | sha256sum -c -)
  tar -xJf "$NODE_TMP/$ARCHIVE" -C /opt
  NODE_DIR="/opt/${ARCHIVE%.tar.xz}"
  for binary in node npm npx; do ln -sfn "$NODE_DIR/bin/$binary" "/usr/local/bin/$binary"; done
  rm -r "$NODE_TMP"
fi
id texas-holdem >/dev/null 2>&1 || useradd --system --home-dir /var/lib/texas-holdem --shell /usr/sbin/nologin texas-holdem
install -d -o texas-holdem -g texas-holdem -m 700 /var/lib/texas-holdem /var/lib/texas-holdem/backups
install -d -m 755 /var/www/texas-acme
cd "$RELEASE"
npm ci --omit=dev --no-audit --no-fund
printf 'PUBLIC_ORIGIN=https://%s:%s\nPORT=3000\nDB_PATH=/var/lib/texas-holdem/game.sqlite\nBACKUP_DIR=/var/lib/texas-holdem/backups\nNODE_ENV=production\n' "$IP" "$PORT" >/etc/texas-holdem.env
chmod 640 /etc/texas-holdem.env
chown root:texas-holdem /etc/texas-holdem.env
install -m 644 deploy/texas-holdem.service deploy/texas-holdem-backup.service deploy/texas-holdem-backup.timer /etc/systemd/system/
if [[ ! -f /etc/letsencrypt/live/texas-holdem-ip/fullchain.pem ]]; then
  cat >/etc/nginx/sites-available/texas-holdem <<EOF
server {
 listen 80;
 server_name $IP;
 location ^~ /.well-known/acme-challenge/ { root /var/www/texas-acme; }
 location / { return 308 https://$IP:$PORT\$request_uri; }
}
EOF
  rm -f /etc/nginx/sites-enabled/default
  ln -sfn /etc/nginx/sites-available/texas-holdem /etc/nginx/sites-enabled/texas-holdem
  nginx -t
  systemctl enable --now nginx
  systemctl reload nginx
fi
if [[ ! -x /snap/bin/certbot ]]; then snap install --classic certbot; fi
CERTBOT_VERSION=$(/snap/bin/certbot --version | awk '{print $2}')
dpkg --compare-versions "$CERTBOT_VERSION" ge 5.4 || { echo 'Certbot 5.4+ required'; exit 1; }
/snap/bin/certbot certonly --non-interactive --agree-tos --register-unsafely-without-email \
  --webroot -w /var/www/texas-acme --ip-address "$IP" --cert-name texas-holdem-ip \
  --preferred-profile shortlived --keep-until-expiring
install -d /etc/letsencrypt/renewal-hooks/deploy
printf '#!/bin/sh\n/usr/sbin/nginx -t && /bin/systemctl reload nginx\n' >/etc/letsencrypt/renewal-hooks/deploy/texas-nginx
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/texas-nginx
sed -e "s/__IP__/$IP/g" -e "s/__PORT__/$PORT/g" deploy/nginx.conf >/etc/nginx/sites-available/texas-holdem
nginx -t
PREVIOUS=$(readlink -f "$BASE/current" || true)
if [[ -f /var/lib/texas-holdem/game.sqlite && -n "$PREVIOUS" && -f "$PREVIOUS/dist-server/backup.js" ]]; then
  systemctl start texas-holdem-backup.service
fi
ln -sfn "$RELEASE" "$BASE/current.next"
mv -Tf "$BASE/current.next" "$BASE/current"
systemctl daemon-reload
systemctl enable --now texas-holdem-backup.timer
systemctl enable texas-holdem
systemctl restart texas-holdem
HEALTHY=0
for attempt in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:3000/api/health; then HEALTHY=1; break; fi
  sleep 1
done
if [[ "$HEALTHY" != 1 ]]; then
  if [[ -n "$PREVIOUS" && "$PREVIOUS" != "$RELEASE" ]]; then
    ln -sfn "$PREVIOUS" "$BASE/current.next"; mv -Tf "$BASE/current.next" "$BASE/current"
    systemctl restart texas-holdem
  fi
  journalctl -u texas-holdem -n 30 --no-pager
  exit 1
fi
if [[ -n "$PREVIOUS" && "$PREVIOUS" != "$RELEASE" ]]; then ln -sfn "$PREVIOUS" "$BASE/previous"; fi
systemctl reload nginx
systemctl start texas-holdem-backup.service
printf '\nDeployed: https://%s:%s\nRelease: %s\n' "$IP" "$PORT" "$RELEASE"
