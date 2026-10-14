#!/usr/bin/env bash
# Update an OpenICQ install to the latest GitHub release.
#
#   sudo /opt/openicq/update.sh          # update if there is something newer
#   sudo /opt/openicq/update.sh --check  # only report, change nothing
#   sudo /opt/openicq/update.sh v0.6.0   # pin an exact release
#
# The database is backed up first and never touched by the update itself. If
# the new version fails to come up, the previous one is put back.

set -euo pipefail

REPO=${OPENICQ_REPO:-Sid3b00m/openicq}
PREFIX=${OPENICQ_PREFIX:-/opt/openicq}
DATA_DIR=${OPENICQ_DATA_DIR:-/var/lib/openicq}
SERVICE=openicq.service

die() { echo "error: $*" >&2; exit 1; }
note() { echo -e "\n== $*"; }

WANTED=""
CHECK_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK_ONLY=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) WANTED="$arg" ;;
  esac
done

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v tar >/dev/null 2>&1 || die "tar is required"
[ -f "$PREFIX/package.json" ] || die "no install found at $PREFIX"

CURRENT=$(node -p "require('$PREFIX/package.json').version" 2>/dev/null || echo "unknown")

if [ -n "$WANTED" ]; then
  LATEST=${WANTED#v}
else
  LATEST=$(curl -fsSL -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/$REPO/releases/latest" \
    | grep -m1 '"tag_name"' | cut -d'"' -f4 | sed 's/^v//') \
    || die "could not reach the GitHub API"
fi
[ -n "$LATEST" ] || die "no releases published for $REPO yet"

echo "  installed : $CURRENT"
echo "  latest    : $LATEST"

if [ "$CURRENT" = "$LATEST" ] && [ -z "$WANTED" ]; then
  echo -e "\nAlready up to date."
  exit 0
fi
if [ "$CHECK_ONLY" -eq 1 ]; then
  echo -e "\nAn update is available. Re-run without --check to install it."
  exit 1
fi

[ "$(id -u)" -eq 0 ] || die "run this with sudo"

# --- back up ----------------------------------------------------------------

note "Backing up"
if [ -x "$PREFIX/backup.sh" ]; then
  OPENICQ_DATA="$DATA_DIR/openicq.json" "$PREFIX/backup.sh" || true
fi

ROLLBACK=$(mktemp -d)
cp -r "$PREFIX" "$ROLLBACK/openicq"
echo "   previous version kept in $ROLLBACK"

# --- fetch ------------------------------------------------------------------

note "Downloading v$LATEST"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
curl -fsSL "https://github.com/$REPO/archive/refs/tags/v$LATEST.tar.gz" -o "$WORK/src.tgz" \
  || die "could not download v$LATEST"
tar -xzf "$WORK/src.tgz" -C "$WORK"
SRC=$(find "$WORK" -maxdepth 1 -type d -name 'openicq-*' | head -n1)
[ -n "$SRC" ] && [ -f "$SRC/server/index.js" ] || die "the downloaded archive does not look like OpenICQ"

# --- install ----------------------------------------------------------------

note "Installing"
for item in server public; do
  rm -rf "${PREFIX:?}/$item"
  cp -r "$SRC/$item" "$PREFIX/$item"
done
for item in package.json LICENSE README.md; do
  [ -f "$SRC/$item" ] && cp "$SRC/$item" "$PREFIX/$item"
done
[ -f "$SRC/deploy/backup.sh" ] && install -m 0755 "$SRC/deploy/backup.sh" "$PREFIX/backup.sh"
[ -f "$SRC/deploy/update.sh" ] && install -m 0755 "$SRC/deploy/update.sh" "$PREFIX/update.sh"
chown -R root:root "$PREFIX"
chmod -R go-w "$PREFIX"

# A release may add new units or options; refresh them but keep the env file.
if [ -f "$SRC/deploy/openicq.service" ]; then
  install -m 0644 "$SRC/deploy/openicq.service" /etc/systemd/system/openicq.service
  systemctl daemon-reload
fi

# --- restart and verify ------------------------------------------------------

note "Restarting"
systemctl restart "$SERVICE"

for i in $(seq 1 30); do
  if systemctl is-active --quiet "$SERVICE"; then
    sleep 1
    if systemctl is-active --quiet "$SERVICE"; then
      note "Now running $(node -p "require('$PREFIX/package.json').version")"
      echo "   rollback copy: $ROLLBACK (delete it when you are happy)"
      exit 0
    fi
  fi
  sleep 1
done

# --- roll back ----------------------------------------------------------------

note "The new version did not stay up; rolling back"
rm -rf "${PREFIX:?}"
cp -r "$ROLLBACK/openicq" "$PREFIX"
systemctl daemon-reload
systemctl restart "$SERVICE"
echo "   restored $CURRENT"
echo "   look at: journalctl -u $SERVICE -n 50"
exit 1
