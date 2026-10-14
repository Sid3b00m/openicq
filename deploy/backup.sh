#!/usr/bin/env bash
# Snapshot the OpenICQ database. Driven by openicq-backup.timer.

set -euo pipefail

DATA=${OPENICQ_DATA:-/var/lib/openicq/openicq.json}
DEST=${OPENICQ_BACKUP_DIR:-/var/lib/openicq/backups}
KEEP=${OPENICQ_BACKUP_KEEP:-14}

[ -f "$DATA" ] || { echo "no database at $DATA yet"; exit 0; }

mkdir -p "$DEST"
chmod 0700 "$DEST"

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
TARGET="$DEST/openicq-$STAMP.json.gz"

# The server writes by atomic rename, so a plain read is always a whole file.
gzip -c "$DATA" > "$TARGET"
chmod 0600 "$TARGET"

# Keep the newest $KEEP snapshots.
ls -1t "$DEST"/openicq-*.json.gz 2>/dev/null | tail -n "+$((KEEP + 1))" | xargs -r rm --

echo "wrote $TARGET"
