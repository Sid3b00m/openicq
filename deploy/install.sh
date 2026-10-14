#!/usr/bin/env bash
# Install OpenICQ as a system service on a fresh Debian/Ubuntu/Fedora/RHEL box.
#
#   sudo ./deploy/install.sh icq.example.com admin@icq.example.com
#
# Re-running it is safe: it updates the files in place and restarts the service
# without touching the database.

set -euo pipefail

DOMAIN=${1:-}
EMAIL=${2:-}
PORT=${PORT:-5190}
PREFIX=/opt/openicq
DATA_DIR=/var/lib/openicq
CONF_DIR=/etc/openicq
SRC=$(cd "$(dirname "$0")/.." && pwd)

die() { echo "error: $*" >&2; exit 1; }
note() { echo -e "\n== $*"; }

[ "$(id -u)" -eq 0 ] || die "run this with sudo"
[ -n "$DOMAIN" ] || die "usage: $0 <domain> [email]"
[ -f "$SRC/server/index.js" ] || die "run this from inside the openicq checkout"

# --- node ------------------------------------------------------------------

if ! command -v node >/dev/null 2>&1; then
  note "Installing Node.js"
  if command -v apt-get >/dev/null 2>&1; then
    command -v curl >/dev/null 2>&1 || apt-get install -y curl
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y nodejs
  else
    die "install Node.js 18+ yourself, then re-run"
  fi
fi

MAJOR=$(node -p "process.versions.node.split('.')[0]")
[ "$MAJOR" -ge 18 ] || die "Node.js 18 or newer is required (found $(node -v))"

# --- account and directories -----------------------------------------------

if ! id openicq >/dev/null 2>&1; then
  note "Creating the openicq system user"
  useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin openicq
fi

note "Installing to $PREFIX"
install -d -m 0755 "$PREFIX"
# Only the parts a server needs; no tests, desktop shell or git metadata.
# Directories are cleared first so re-running does not nest server/server.
for item in server public; do
  rm -rf "${PREFIX:?}/$item"
  cp -r "$SRC/$item" "$PREFIX/$item"
done
for item in package.json LICENSE README.md; do
  cp "$SRC/$item" "$PREFIX/$item"
done
chown -R root:root "$PREFIX"
chmod -R go-w "$PREFIX"

install -d -m 0700 -o openicq -g openicq "$DATA_DIR"
install -d -m 0750 -o root -g openicq "$CONF_DIR"

# --- configuration ----------------------------------------------------------

if [ ! -f "$CONF_DIR/openicq.env" ]; then
  note "Writing $CONF_DIR/openicq.env"
  sed \
    -e "s|^OPENICQ_ORIGINS=.*|OPENICQ_ORIGINS=https://$DOMAIN|" \
    -e "s|^PORT=.*|PORT=$PORT|" \
    "$SRC/deploy/openicq.env.example" > "$CONF_DIR/openicq.env"
  chown root:openicq "$CONF_DIR/openicq.env"
  chmod 0640 "$CONF_DIR/openicq.env"
else
  echo "   keeping the existing $CONF_DIR/openicq.env"
fi

# --- service ----------------------------------------------------------------

note "Installing the systemd units"
install -m 0644 "$SRC/deploy/openicq.service" /etc/systemd/system/openicq.service
install -m 0644 "$SRC/deploy/openicq-backup.service" /etc/systemd/system/openicq-backup.service
install -m 0644 "$SRC/deploy/openicq-backup.timer" /etc/systemd/system/openicq-backup.timer
install -m 0755 "$SRC/deploy/backup.sh" "$PREFIX/backup.sh"
install -m 0755 "$SRC/deploy/update.sh" "$PREFIX/update.sh"

systemctl daemon-reload
systemctl enable --now openicq.service
systemctl enable --now openicq-backup.timer

# --- reverse proxy ----------------------------------------------------------

if command -v caddy >/dev/null 2>&1; then
  note "Configuring Caddy for $DOMAIN"
  sed -e "s|icq.example.com|$DOMAIN|g" \
      -e "s|admin@icq.example.com|${EMAIL:-admin@$DOMAIN}|" \
      -e "s|127.0.0.1:5190|127.0.0.1:$PORT|" \
      "$SRC/deploy/Caddyfile" > /etc/caddy/Caddyfile
  systemctl reload caddy || systemctl restart caddy
  PROXY=caddy
elif command -v nginx >/dev/null 2>&1; then
  note "Configuring nginx for $DOMAIN"
  sed -e "s|icq.example.com|$DOMAIN|g" -e "s|127.0.0.1:5190|127.0.0.1:$PORT|" \
      "$SRC/deploy/nginx.conf" > /etc/nginx/sites-available/openicq
  ln -sf /etc/nginx/sites-available/openicq /etc/nginx/sites-enabled/openicq
  echo "   now run: certbot --nginx -d $DOMAIN"
  PROXY=nginx
else
  note "No reverse proxy found"
  echo "   Install Caddy (easiest, automatic TLS):"
  echo "     https://caddyserver.com/docs/install"
  echo "   then re-run this script. OpenICQ is listening on 127.0.0.1:$PORT"
  echo "   and is NOT reachable from outside until a proxy fronts it."
  PROXY=none
fi

# --- firewall ----------------------------------------------------------------

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  note "Opening HTTP/HTTPS in ufw"
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  # The app port stays closed: only the local proxy talks to it.
  ufw deny "$PORT"/tcp >/dev/null || true
fi

# --- done ---------------------------------------------------------------------

note "Done"
systemctl --no-pager --lines=0 status openicq.service || true
cat <<EOF

  Service   : systemctl status openicq
  Logs      : journalctl -u openicq -f
  Config    : $CONF_DIR/openicq.env
  Database  : $DATA_DIR/openicq.json
  Backups   : $DATA_DIR/backups (daily, 14 kept)
  Updates   : sudo $PREFIX/update.sh --check
  Proxy     : $PROXY

  Visit https://$DOMAIN and click "New UIN..." to claim 100000.

  Once everyone you want has an account, close sign-ups:
    echo 'OPENICQ_REGISTRATION=off' >> $CONF_DIR/openicq.env
    systemctl restart openicq
EOF
