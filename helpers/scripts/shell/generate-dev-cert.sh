#!/usr/bin/env bash
# generate-dev-cert.sh — genera un certificado autofirmado para la PoC de galaxIA.
#
# NO usar en producción. Un solo certificado autofirmado se comparte entre
# navigator, star, satellite-ocr y nginx — todos los clientes FHS
# lo aceptan con rejectUnauthorized:false (ver docs/tls-autofirmado.md).
#
# Uso:
#   helpers/scripts/shell/generate-dev-cert.sh [IP_LAPTOP] [IP_BASTION]
#
# Ejemplo (topología multi-host de esta PoC):
#   helpers/scripts/shell/generate-dev-cert.sh 192.168.3.137 192.168.3.173
set -euo pipefail

IP_LAPTOP="${1:-127.0.0.1}"
IP_BASTION="${2:-127.0.0.1}"
OUT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/certs"
DAYS="${TLS_CERT_DAYS:-825}"

mkdir -p "$OUT_DIR"

echo "→ Generando certificado autofirmado en $OUT_DIR"
echo "  SAN: localhost, 127.0.0.1, ${IP_LAPTOP}, ${IP_BASTION}"

openssl req -x509 -nodes -newkey rsa:2048 \
  -days "$DAYS" \
  -keyout "$OUT_DIR/dev.key" \
  -out "$OUT_DIR/dev.crt" \
  -subj "/CN=galaxia-poc" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:${IP_LAPTOP},IP:${IP_BASTION}"

chmod 600 "$OUT_DIR/dev.key"

echo "✓ Listo: $OUT_DIR/dev.crt y $OUT_DIR/dev.key"
echo "  Estos archivos NO se suben a git (ver .gitignore) — regenerar en cada máquina"
echo "  que necesite servir TLS, o copiar el mismo par a laptop y bastion."
