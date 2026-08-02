#!/usr/bin/env bash
# Verifica si un puerto está libre (exit 0) u ocupado (exit 1).
# Uso: port-check.sh <puerto>

set -euo pipefail

PORT="${1:-}"

if [ -z "$PORT" ]; then
    echo "Uso: port-check.sh <puerto>" >&2
    exit 2
fi

if lsof -i ":$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    proc=$(lsof -i ":$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)
    name=$(ps -p "$proc" -o comm= 2>/dev/null || echo "desconocido")
    echo "PUERTO $PORT OCUPADO por PID $proc ($name)"
    exit 1
else
    echo "PUERTO $PORT LIBRE"
    exit 0
fi
