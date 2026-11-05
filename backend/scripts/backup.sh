#!/bin/bash
# Snapshots all mutable app data (JSON stores, logs, generated PDFs) so a
# bad bulk admin action or accidental delete can be rolled back. Runs on
# a schedule via cron and can also be called manually before any
# destructive operation.
set -e

BACKEND="/opt/lifestyle-ceramics/backend"
BACKUP_ROOT="/opt/lifestyle-ceramics/backups"
STAMP=$(date +%Y-%m-%d_%H%M%S)
DEST="$BACKUP_ROOT/$STAMP"

mkdir -p "$DEST"

# Data files that change via the app (not code, not node_modules).
cp -p "$BACKEND"/*.json "$DEST"/ 2>/dev/null || true
cp -p "$BACKEND"/*.log "$DEST"/ 2>/dev/null || true

# Issued/sent quotation PDFs — not reproducible once a quote is edited.
if [ -d "$BACKEND/formal-documents-private" ]; then
  mkdir -p "$DEST/formal-documents-private"
  cp -p "$BACKEND/formal-documents-private"/*.pdf "$DEST/formal-documents-private/" 2>/dev/null || true
fi

# Keep the most recent 60 snapshots (at 4/day that's ~2 weeks; prune older).
cd "$BACKUP_ROOT"
ls -1dt */ 2>/dev/null | tail -n +61 | xargs -r rm -rf

echo "Backup written to $DEST"
