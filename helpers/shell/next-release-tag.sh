#!/bin/sh
# Calcula el siguiente tag de release alpha: vX.Y.Z-alpha.N.
#
# Sin tags previos que matcheen v*-alpha.*, el primero es v0.1.0-alpha.1
# (versión base de los 4 paquetes distribuibles en este ciclo). Con un tag
# previo, sube N en 1 y mantiene X.Y.Z — subir X.Y.Z (pasar de alpha a un
# release estable) es una decisión manual, no automática por este script.
#
# Uso: helpers/shell/next-release-tag.sh
# Compatible POSIX sh (funciona en Alpine, macOS, Linux).
set -eu

TAGS=$(git tag -l 'v[0-9]*.[0-9]*.[0-9]*-alpha.[0-9]*' --sort=-v:refname)
LAST_TAG=$(printf '%s\n' "$TAGS" | head -n 1)

if [ -z "$LAST_TAG" ]; then
  echo "v0.1.0-alpha.1"
  exit 0
fi

BASE=$(printf '%s\n' "$LAST_TAG" | sed 's/^\(v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)-alpha\.[0-9][0-9]*$/\1/')
N=$(printf '%s\n' "$LAST_TAG" | sed 's/^v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*-alpha\.\([0-9][0-9]*\)$/\1/')

if [ "$BASE" = "$LAST_TAG" ] || [ "$N" = "$LAST_TAG" ]; then
  echo "✗ ERROR: '$LAST_TAG' no matchea el formato esperado vX.Y.Z-alpha.N" >&2
  exit 1
fi

echo "${BASE}-alpha.$((N + 1))"
