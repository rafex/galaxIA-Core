# helpers/just/test.just — recetas de test
# Incluir con: import 'helpers/just/test.just'

import 'common.just'

# ── Smoke Test ─────────────────────────────────────────────────────────────

# Verifica que el navigator esté respondiendo en /health
test-smoke:
    @echo "→ Smoke test: verificando navigator..."
    curl -sfS http://localhost:{{AGENT_PORT}}/health && echo "  OK" || { echo "  FAIL"; exit 1; }

# ── Chat Test ──────────────────────────────────────────────────────────────

# Envía un mensaje de prueba al chat por WebSocket
test-chat message="Hola, ¿cómo estás?":
    @echo "→ Test chat WebSocket: {{message}}"
    npx tsx scripts/test-chat-ws.ts "{{message}}"

# ── Typecheck ──────────────────────────────────────────────────────────────

# Ejecuta typecheck en todos los workspaces
test-typecheck:
    @echo "→ Typecheck..."
    npm run typecheck --workspaces && echo "  OK"
