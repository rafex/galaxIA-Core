#!/usr/bin/env python3
"""Genera un archivo .env para desarrollo local con puertos libres.

Uso: python3 helpers/scripts/python/generate-env.py [--check] [--write]

  --check   solo verifica, no escribe
  --write   escribe .env en la raíz del proyecto
"""

import socket
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]

PORTS = {
    "AGENT_SERVER_PORT": 8083,
    "WEB_PORT": 3000,
    "LLM_PROVIDER_PORT": 43111,
    "OCR_PROVIDER_PORT": 43112,
    "MOCK_LLM_PORT": 43110,
}


def is_port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def find_free(start: int, max_attempts: int = 20) -> int:
    for offset in range(max_attempts):
        port = start + offset
        if is_port_free(port):
            return port
    return start


def main():
    check_only = "--check" in sys.argv or "-c" in sys.argv
    write = "--write" in sys.argv or "-w" in sys.argv

    lines = [
        "# galaxIA — variables de entorno para desarrollo local",
        f"# Generado por helpers/scripts/python/generate-env.py",
        "",
    ]

    all_ok = True
    for var, default_port in PORTS.items():
        port = find_free(default_port)
        status = "libre" if port == default_port else f"cambiado a {port}"
        if port != default_port:
            all_ok = False
        lines.append(f"{var}={port}  # {status}")

    lines.extend(
        [
            "",
            "REGISTRY_URL=ws://localhost:${AGENT_SERVER_PORT}/fhs/v1/ws",
            f"LLAMA_CPP_URL=http://localhost:{find_free(43110)}/v1",
            "OCR_SERVICE_URL=http://localhost:8082",
            "",
            "# Provider IDs",
            "PROVIDER_ID_LLM=did:key:macmini-raul",
            "PROVIDER_ID_OCR=did:key:ocr-provider-01",
            "",
            "# Container compose",
            "COMPOSE_CMD=podman-compose",
        ]
    )

    content = "\n".join(lines) + "\n"

    if check_only:
        print(content)
        if all_ok:
            print("\nTodos los puertos libres.")
        else:
            print("\nAlgunos puertos están ocupados — ver alternativas arriba.")
        return

    if write:
        env_path = ROOT / ".env"
        env_path.write_text(content)
        print(f".env escrito en {env_path}")
        if not all_ok:
            print("AVISO: algunos puertos estaban ocupados y se asignaron alternativas.")
        return

    print(content)


if __name__ == "__main__":
    main()
