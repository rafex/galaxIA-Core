#!/bin/sh
# Compila un workspace y verifica que el tarball que npm publicaría
# realmente incluya dist/ compilado.
#
# Existe porque la versión 0.1.0 de @rafex/galaxia-fhs-protocol se publicó
# rota: sin un campo "files" en package.json, `npm publish` respeta
# .gitignore para decidir qué empaquetar, y dist/ está gitignored (es un
# artefacto de build) — el tarball solo traía src/, package.json y
# tsconfig.json. Nadie lo notó porque el workflow "terminó sin error"; solo
# se detectó al instalarlo de verdad (ver spec-native/DECISIONS.md DEC-0040).
# Generalizado (antes verify-protocol-package.sh, solo para
# packages/fhs-protocol) para reusarse en los 4 paquetes distribuibles.
#
# Este script hace ese chequeo automático, para que no vuelva a pasar en
# silencio: build -> `npm pack --dry-run --json` -> falla si dist/*.js no
# aparece en la lista de archivos del tarball.
#
# Uso: helpers/shell/verify-package.sh <workspace>
#   <workspace>  ruta relativa a la raíz del repo, ej. packages/fhs-protocol,
#                apps/atlas, apps/navigator, apps/portal-chat
# Compatible POSIX sh (funciona en Alpine, macOS, Linux). Requiere jq.
set -eu

WORKSPACE="${1:?Uso: helpers/shell/verify-package.sh <workspace>}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PKG_DIR="$ROOT/$WORKSPACE"

echo "→ Compilando $WORKSPACE..."
npm run build -w "$WORKSPACE" --prefix "$ROOT"

echo "→ Verificando contenido del tarball (npm pack --dry-run)..."
PACK_JSON=$(cd "$PKG_DIR" && npm pack --dry-run --json 2>/dev/null)

DIST_FILE_COUNT=$(echo "$PACK_JSON" | jq '[.[0].files[] | select(.path | startswith("dist/") and endswith(".js"))] | length')

if [ "$DIST_FILE_COUNT" -eq 0 ]; then
  echo "✗ ERROR: el tarball no incluye ningún archivo dist/*.js" >&2
  echo "  Revisa el campo \"files\" en $WORKSPACE/package.json" >&2
  echo "  (dist/ está gitignored — sin \"files\": [\"dist\"], npm publish lo excluye)." >&2
  exit 1
fi

echo "✓ Tarball incluye $DIST_FILE_COUNT archivo(s) dist/*.js — contenido correcto."
