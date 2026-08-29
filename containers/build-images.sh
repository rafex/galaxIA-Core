#!/usr/bin/env bash
# containers/build-images.sh — Build y publicación de imágenes galaxIA-Core
#
# Uso:
#   bash containers/build-images.sh               # build local, tag latest
#   bash containers/build-images.sh --push        # build + push a GHCR
#   bash containers/build-images.sh --tag v0.2.0  # tag específico
#   bash containers/build-images.sh --export      # guarda .tar.gz en dist/images/
#
# Para multi-arch (Raspi4B ARM64 + x86_64):
#   bash containers/build-images.sh --arch linux/amd64,linux/arm64 --push
#
# Variables de entorno requeridas para el push a GHCR:
#   GITHUB_TOKEN  — token con permiso write:packages

set -euo pipefail

# ── Parámetros ──────────────────────────────────────────────────────────────
TAG="latest"
PUSH=false
EXPORT=false
ARCH=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag)     TAG="$2"; shift 2 ;;
    --push)    PUSH=true; shift ;;
    --export)  EXPORT=true; shift ;;
    --arch)    ARCH="$2"; shift 2 ;;
    *) echo "Uso: $0 [--tag TAG] [--push] [--export] [--arch PLATAFORMAS]"; exit 1 ;;
  esac
done

# ── Constantes ───────────────────────────────────────────────────────────────
REGISTRY="ghcr.io/rafex"
COMMIT_HASH="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
BUILD_TOOL="${PODMAN:-$(command -v podman 2>/dev/null || command -v docker)}"

# Componentes: nombre_imagen:Containerfile_relativo
declare -A IMAGES=(
  ["galaxia-atlas"]="containers/atlas/Containerfile"
  ["galaxia-navigator"]="containers/navigator/Containerfile"
  ["galaxia-portal-chat"]="containers/portal-chat/Containerfile"
  ["galaxia-log-agent"]="containers/log-agent/Containerfile"
)

# ── Funciones ────────────────────────────────────────────────────────────────
log()  { printf "\033[36m[build]\033[0m %s\n" "$*"; }
ok()   { printf "\033[32m[ok]\033[0m    %s\n" "$*"; }
warn() { printf "\033[33m[warn]\033[0m  %s\n" "$*"; }
err()  { printf "\033[31m[error]\033[0m %s\n" "$*" >&2; }

build_image() {
  local name="$1"
  local cfile="$2"
  local full_tag="${REGISTRY}/${name}:${TAG}"

  log "Construyendo ${name}:${TAG} desde ${cfile}"

  local args=(
    build
    --build-arg "COMMIT_HASH=${COMMIT_HASH}"
    --build-arg "BUILD_DATE=${BUILD_DATE}"
    -t "${REGISTRY}/${name}:${TAG}"
    -t "${name}:${TAG}"
    -f "${cfile}"
    .
  )

  if [[ -n "$ARCH" ]]; then
    args+=(--platform "$ARCH")
  fi

  "${BUILD_TOOL}" "${args[@]}"
  ok "${name}:${TAG} — listo"
}

push_image() {
  local name="$1"
  local full_tag="${REGISTRY}/${name}:${TAG}"
  log "Publicando ${full_tag}"
  "${BUILD_TOOL}" push "${full_tag}"
  ok "Publicado → ${full_tag}"
}

export_image() {
  local name="$1"
  local out_dir="dist/images"
  mkdir -p "${out_dir}"
  local out="${out_dir}/${name}-${TAG}.tar.gz"
  log "Exportando ${name}:${TAG} → ${out}"
  "${BUILD_TOOL}" save "${REGISTRY}/${name}:${TAG}" | gzip > "${out}"
  ok "Exportado → ${out}"
}

# ── Main ─────────────────────────────────────────────────────────────────────
if $PUSH && [[ -z "${GITHUB_TOKEN:-}" ]]; then
  warn "GITHUB_TOKEN no definida — el push puede fallar si no estás logueado"
fi

for name in "${!IMAGES[@]}"; do
  cfile="${IMAGES[$name]}"
  build_image "$name" "$cfile"
  $EXPORT && export_image "$name"
  $PUSH   && push_image   "$name"
done

echo ""
ok "Todas las imágenes listas (tag=${TAG}, push=${PUSH}, export=${EXPORT})"
