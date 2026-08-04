#!/bin/sh
# Genera version.json con hash del commit para frontend y backend.
# Compatible POSIX sh (funciona en Alpine, macOS, Linux).
# Uso: helpers/scripts/shell/gen-version.sh
set -eu

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"

# Container builds do not include .git. In that case the Containerfile passes
# the deployment commit/date as build arguments and npm's build hook invokes
# this script again. Prefer those explicit values so the hook cannot replace
# the deployment metadata with "unknown".
if [ -n "${COMMIT_HASH:-}" ]; then
  COMMIT="$COMMIT_HASH"
else
  COMMIT=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo "unknown")
fi

if [ -n "${BUILD_DATE:-}" ]; then
  DATE="$BUILD_DATE"
else
  DATE=$(git -C "$ROOT" log -1 --format=%ci 2>/dev/null || date -u "+%Y-%m-%dT%H:%M:%SZ")
fi
JSON=$(printf '{"commit":"%s","date":"%s"}\n' "$COMMIT" "$DATE")

echo "$JSON" > "$ROOT/apps/atlas/src/version.json"
echo "version: atlas -> $COMMIT"

echo "$JSON" > "$ROOT/apps/navigator/src/version.json"
echo "version: backend -> $COMMIT"

echo "$JSON" > "$ROOT/apps/portal-chat/public/version.json"
echo "version: frontend -> $COMMIT"
