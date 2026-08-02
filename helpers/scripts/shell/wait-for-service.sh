#!/usr/bin/env bash
# Espera hasta que un endpoint HTTP responda 200.
# Uso: wait-for-service.sh <url> [timeout_segundos]

set -euo pipefail

URL="${1:-}"
TIMEOUT="${2:-30}"
INTERVAL=2
ELAPSED=0

if [ -z "$URL" ]; then
    echo "Uso: wait-for-service.sh <url> [timeout]" >&2
    exit 2
fi

echo "Esperando a $URL (timeout: ${TIMEOUT}s)..."

while [ "$ELAPSED" -lt "$TIMEOUT" ]; do
    if curl -sfS -o /dev/null "$URL" 2>/dev/null; then
        echo "$URL responde OK (${ELAPSED}s)"
        exit 0
    fi
    sleep "$INTERVAL"
    ELAPSED=$((ELAPSED + INTERVAL))
done

echo "TIMEOUT: $URL no respondió en ${TIMEOUT}s" >&2
exit 1
