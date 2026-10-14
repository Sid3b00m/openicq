#!/usr/bin/env sh
# Start the OpenICQ server and open the client. macOS and every flavour of Linux.

set -eu

DIR=$(cd "$(dirname "$0")" && pwd)
PORT=${PORT:-5190}

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required but was not found on your PATH."
  echo
  echo "  Debian/Ubuntu : sudo apt install nodejs"
  echo "  Fedora/RHEL   : sudo dnf install nodejs"
  echo "  Arch          : sudo pacman -S nodejs"
  echo "  Alpine        : sudo apk add nodejs"
  echo "  openSUSE      : sudo zypper install nodejs"
  echo "  macOS         : brew install node"
  echo "  anything else : https://nodejs.org/en/download"
  exit 1
fi

MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$MAJOR" -lt 18 ]; then
  echo "Node.js 18 or newer is required (found $(node -v))."
  exit 1
fi

open_browser() {
  sleep 1
  URL="http://localhost:$PORT"
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1
  elif command -v open >/dev/null 2>&1; then open "$URL" >/dev/null 2>&1
  elif command -v gio >/dev/null 2>&1; then gio open "$URL" >/dev/null 2>&1
  else echo "Open $URL in your browser."
  fi
}

[ "${NO_BROWSER:-}" = "1" ] || open_browser &

exec node "$DIR/server/index.js" --port "$PORT" "$@"
