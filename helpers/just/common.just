# helpers/just/common.just — variables y funciones compartidas para Justfile
# Incluir con: import 'helpers/just/common.just'

# ── Workspaces ─────────────────────────────────────────────────────────────
# Los providers de referencia (Star/LLM, Satellite/OCR, RAG, KB) viven en el
# repo separado `galaxIA-satellite-star` — ya no son workspaces de este repo.
WS_PROTOCOL := "packages/fhs-protocol"
WS_ATLAS    := "apps/atlas"
WS_AGENT    := "apps/navigator"
WS_WEB      := "apps/portal-chat"

# ── Puerto defaults (se pueden sobrescribir en .env) ───────────────────────
# DEC-0035: ATLAS_PORT (Registry, antes era el mismo AGENT_PORT) y AGENT_PORT
# (chat de Navigator) son procesos separados en desarrollo local también.
ATLAS_PORT     := env_var_or_default("ATLAS_PORT", "8081")
AGENT_PORT     := env_var_or_default("AGENT_SERVER_PORT", "8083")
WEB_PORT       := env_var_or_default("WEB_PORT", "3000")
LLM_PORT       := env_var_or_default("LLM_PROVIDER_PORT", "43111")
OCR_PORT       := env_var_or_default("OCR_PROVIDER_PORT", "43112")
MOCK_LLM_PORT  := env_var_or_default("MOCK_LLM_PORT", "43110")
ATLAS_URL      := env_var_or_default("ATLAS_URL", "http://localhost:" + ATLAS_PORT)
REGISTRY_URL   := env_var_or_default("REGISTRY_URL", "ws://localhost:" + ATLAS_PORT + "/fhs/v1/ws")
LLAMA_CPP_URL  := env_var_or_default("LLAMA_CPP_URL", "http://localhost:" + MOCK_LLM_PORT + "/v1")
OCR_SVC_URL    := env_var_or_default("OCR_SERVICE_URL", "http://localhost:8082")

# ── Contenedores ───────────────────────────────────────────────────────────
# Ruta absoluta a propósito: algunas versiones de podman-compose (ej. 1.3.0)
# hacen chdir() al directorio del compose file antes de abrirlo y luego
# reintentan abrir la ruta original tal cual la recibieron — con una ruta
# relativa como "containers/compose.yaml" eso termina buscando
# "containers/containers/compose.yaml" y falla con FileNotFoundError, aunque
# el archivo exista. Con ruta absoluta no hay ambigüedad en ningún host.
COMPOSE_FILE := justfile_directory() + "/containers/compose.yaml"
COMPOSE_CMD  := `command -v podman-compose >/dev/null && echo podman-compose || echo "docker compose"`

# ── Utilidades ─────────────────────────────────────────────────────────────

# Ejecuta tsx con un workspace
[no-exit-message]
run-tsx workspace file args="":
    npx tsx {{workspace}}/{{file}} {{args}}

# Ejecuta npm script en un workspace
[no-exit-message]
npm-run workspace script args="":
    npm run {{script}} -w {{workspace}} {{args}}
