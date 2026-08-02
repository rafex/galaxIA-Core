#!/usr/bin/env bash
# log-agent-ship.sh — sigue contenedores locales y opcionalmente envía sus
# logs a NATS (DEC-0083, ver docs/observabilidad-logs.md).
#
# Sin runtime aparte: solo `podman` (ya presente en cada host) y el binario
# CLI de NATS (un solo ejecutable estático, sin dependencias — instalar con
# https://github.com/nats-io/natscli#installation). NUNCA depende de NATS
# para seguir escribiendo el archivo local — si `nats pub` falla o
# NATS_URL no está seteada, sigue igual (mismo patrón de degradación que
# apps/atlas/src/atlas/nats-bridge.ts).
#
# Uso:
#   helpers/scripts/shell/log-agent-ship.sh <host_label> <local_dir> <contenedor1> [contenedor2 ...]
#
# Ejemplo (Bastion, topología actual — ver docs/despliegue-multi-host.md):
#   NATS_URL=nats://192.168.1.139:4222 \
#     helpers/scripts/shell/log-agent-ship.sh bastion ./logs fhs-atlas fhs-navigator fhs-star
set -euo pipefail

if [ "$#" -lt 3 ]; then
  echo "Uso: $0 <host_label> <local_dir> <contenedor1> [contenedor2 ...]" >&2
  exit 1
fi

HOST_LABEL="$1"; shift
LOCAL_DIR="$1"; shift
CONTAINERS=("$@")

mkdir -p "$LOCAL_DIR"

follow_container() {
  local container="$1"
  local file="$LOCAL_DIR/${container}.log"

  # Reintenta si el contenedor se reinicia — "podman logs -f" termina
  # cuando el contenedor muere, no cuando la app agente muere.
  while true; do
    podman logs -f --tail 50 "$container" 2>&1 | while IFS= read -r line; do
      echo "$line" >>"$file"
      if [ -n "${NATS_URL:-}" ]; then
        nats pub "logs.${HOST_LABEL}.${container}" "$line" --server "$NATS_URL" >/dev/null 2>&1 || true
      fi
    done
    echo "[log-agent-ship] \"podman logs -f $container\" terminó — reintentando en 5s" >&2
    sleep 5
  done
}

echo "[log-agent-ship] host=\"$HOST_LABEL\" contenedores=[${CONTAINERS[*]}] nats=${NATS_URL:-"(no configurada, solo local)"}"

for container in "${CONTAINERS[@]}"; do
  follow_container "$container" &
done

wait
