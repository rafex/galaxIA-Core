# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Sube la version patch del package.json de un workspace si la version
actual ya esta publicada en GitHub Packages.

Por que existe: publicar una version nueva de un paquete (@rafex/galaxia-
fhs-protocol, @galaxia/atlas, @galaxia/navigator, @galaxia/portal-chat)
requiere subir el campo "version" en su package.json ANTES de mergear a
main (spec-native/pipelines/CD.md) -- si se olvida, el workflow de
publicacion simplemente no hace nada (detecta que la version ya existe y
se salta el publish). Este script automatiza ese paso: consulta GitHub
Packages, y si la version actual ya fue publicada, sube el patch
automaticamente. Generalizado (antes bump_protocol_version.py, solo para
packages/fhs-protocol) para reusarse en los 4 paquetes distribuibles.

Uso:
    uv run helpers/python/bump_package_version.py <workspace> [--check]

    <workspace>  ruta del workspace relativa a la raiz del repo, ej.
                 packages/fhs-protocol, apps/atlas, apps/navigator,
                 apps/portal-chat
    --check      solo reporta si haria falta un bump, no escribe nada
                 (exit code 1 si la version actual ya esta publicada)

Variables de entorno:
    GH_TOKEN   token con permiso read:packages (requerido -- GitHub
               Packages exige autenticacion incluso para paquetes publicos)
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

REGISTRY = "https://npm.pkg.github.com"
ROOT = Path(__file__).resolve().parents[2]


def read_version(package_json: dict) -> tuple[int, int, int]:
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)", package_json["version"])
    if not match:
        raise ValueError(f"Version no es semver simple: {package_json['version']!r}")
    return tuple(int(g) for g in match.groups())  # type: ignore[return-value]


def is_version_published(package_name: str, version: str, token: str) -> bool:
    """Consulta GitHub Packages directamente (no via npm view) para no
    depender de que el .npmrc local ya este configurado con el registro."""
    encoded_name = package_name.replace("/", "%2f")
    url = f"{REGISTRY}/{encoded_name}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as err:
        if err.code == 404:
            return False
        raise
    return version in data.get("versions", {})


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    check_only = "--check" in sys.argv[1:]

    if not args:
        print("✗ ERROR: falta el argumento <workspace> (ver docstring).", file=sys.stderr)
        return 2
    workspace = args[0]
    package_json_path = ROOT / workspace / "package.json"

    token = os.environ.get("GH_TOKEN")
    if not token:
        print("✗ ERROR: falta la variable de entorno GH_TOKEN (ver docstring).", file=sys.stderr)
        return 2

    package_json = json.loads(package_json_path.read_text())
    package_name = package_json["name"]
    major, minor, patch = read_version(package_json)
    current_version = f"{major}.{minor}.{patch}"

    published = is_version_published(package_name, current_version, token)

    if not published:
        print(f"✓ {package_name}@{current_version} todavía no está publicada — no hace falta bump.")
        return 0

    next_version = f"{major}.{minor}.{patch + 1}"

    if check_only:
        print(f"✗ {package_name}@{current_version} ya está publicada — haría falta subir a {next_version}.", file=sys.stderr)
        return 1

    package_json["version"] = next_version
    package_json_path.write_text(json.dumps(package_json, indent=2) + "\n")
    print(f"→ {package_name}@{current_version} ya estaba publicada — version subida a {next_version}.")

    # También refleja el bump en package-lock.json si existe, para que
    # `npm ci` no se queje de desincronización.
    lock_path = ROOT / "package-lock.json"
    if lock_path.exists():
        subprocess.run(
            ["npm", "install", "--package-lock-only", "-w", workspace],
            cwd=ROOT,
            check=True,
        )
        print("→ package-lock.json actualizado.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
