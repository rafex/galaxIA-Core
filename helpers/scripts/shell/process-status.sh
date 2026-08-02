#!/usr/bin/env bash
# Lista procesos del proyecto galaxIA con puertos.
# Uso: process-status.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"

echo "SERVICIO               PUERTO(HOST)  INTERNO    PID     COMANDO"
echo "────────────────────   ────────────  ────────   ─────   ──────"

check_port() {
    local host_port="$1"
    local internal_port="$2"
    local label="$3"
    if lsof -i ":$host_port" -sTCP:LISTEN >/dev/null 2>&1; then
        local pid
        pid=$(lsof -i ":$host_port" -sTCP:LISTEN -t 2>/dev/null | head -1)
        local cmd
        cmd=$(ps -p "$pid" -o args= 2>/dev/null | sed 's/.*node //' | sed 's/.*tsx //' | cut -c1-40)
        printf "%-22s %-13s %-9s %-7s %s\n" "$label" ":$host_port" ":$internal_port" "$pid" "$cmd"
    else
        printf "%-22s %-13s %-9s %-7s %s\n" "$label" ":$host_port" ":$internal_port" "—" "no activo"
    fi
}

check_container() {
    local host_port="$1"
    local label="$2"
    if lsof -i ":$host_port" -sTCP:LISTEN >/dev/null 2>&1; then
        local pid
        pid=$(lsof -i ":$host_port" -sTCP:LISTEN -t 2>/dev/null | head -1)
        printf "%-22s %-13s %-9s %-7s %s\n" "$label" ":$host_port" "(container)" "$pid" "podman/docker"
    else
        printf "%-22s %-13s %-9s %-7s %s\n" "$label" ":$host_port" "(container)" "—" "no activo"
    fi
}

echo "── Desarrollo local ──"
check_port 8081 8081 "atlas"
check_port 8083 8083 "navigator"
check_port 5173 5173 "web (vite dev)"
check_port 43111 43111 "star"
check_port 43112 43112 "satellite-ocr"
check_port 43110 43110 "mock-llm / llama.cpp"
check_port 8082 8082 "ocr-mcp (raw)"

echo ""
echo "── Contenedores (bastion) ──"
check_container 3000  "web"
check_container 30083 "atlas"
check_container 30084 "star"
check_container 30085 "satellite-ocr"
check_container 30082 "ocr-mcp (raw)"
check_container 43110 "llama.cpp (host)"

