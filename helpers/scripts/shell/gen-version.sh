#!/bin/sh
# Genera version.json con hash del commit para frontend y backend.
# Compatible POSIX sh (funciona en Alpine, macOS, Linux).
# Uso: helpers/scripts/shell/gen-version.sh
set -eu

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"

COMMIT=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo "unknown")
DATE=$(git -C "$ROOT" log -1 --format=%ci 2>/dev/null || date -u "+%Y-%m-%dT%H:%M:%SZ")
JSON=$(printf '{"commit":"%s","date":"%s"}\n' "$COMMIT" "$DATE")

echo "$JSON" > "$ROOT/apps/atlas/src/version.json"
echo "version: atlas -> $COMMIT"

echo "$JSON" > "$ROOT/apps/navigator/src/version.json"
echo "version: backend -> $COMMIT"

echo "$JSON" > "$ROOT/apps/portal-chat/public/version.json"
echo "version: frontend -> $COMMIT"
