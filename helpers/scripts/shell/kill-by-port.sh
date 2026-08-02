#!/usr/bin/env bash
# Mata el proceso que escucha en un puerto.
# Uso: kill-by-port.sh <puerto>

set -euo pipefail

PORT="${1:-}"

if [ -z "$PORT" ]; then
    echo "Uso: kill-by-port.sh <puerto>" >&2
    exit 2
fi

if ! lsof -i ":$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "Nada escuchando en puerto $PORT"
    exit 0
fi

pids=$(lsof -i ":$PORT" -sTCP:LISTEN -t 2>/dev/null)

for pid in $pids; do
    name=$(ps -p "$pid" -o comm= 2>/dev/null || echo "desconocido")
    echo "Matando PID $pid ($name) en puerto $PORT..."
    kill "$pid" 2>/dev/null || true
done

# Esperar a que se libere
for i in $(seq 1 5); do
    if ! lsof -i ":$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
        echo "Puerto $PORT liberado"
        exit 0
    fi
    sleep 1
done

echo "AVISO: puerto $PORT podría seguir ocupado" >&2
exit 0
