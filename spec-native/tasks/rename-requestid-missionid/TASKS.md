# TASKS.md — Rename requestId → missionId en galaxIA-Core

## Metadata

- Iniciativa: `rename-requestid-missionid`
- DEC relacionada: DEC-0085 (rename de campo wire protocol)
- Owner: rafex
- Estado general: `done`
- Origen: trasladado desde galaxIA (repo IDL-only) — tareas originales #51, #52, #53, #54

## Contexto

El campo `requestId` en todos los mensajes del protocolo FHS (ChatRequest, ChatCancel,
ChatDelta, ChatCompleted, ChatError, DispatchAck, ToolCallRequest, ToolCancel, ToolCallResult,
ToolCallError, ToolListRequest, ToolListResponse) fue renombrado a `missionId` (DEC-0085).

El rename revierte DEC-0084 (que había decidido NO renombrarlo) tras decisión explícita del
operador. El campo wire cambia: el JSON en el cable pasa de `"requestId"` a `"missionId"`.
Este cambio es un flag-day: todos los nodos que se comunican deben actualizarse de forma
coordinada antes de reiniciar.

El blast radius en este repo:
- `apps/navigator/src/providers/llm-gateway.ts` — construcción/correlación de chat.request/chat.cancel
- `apps/navigator/src/providers/mcp-host.ts` — construcción/correlación de tool.call/tool.cancel, mapa pending
- `apps/navigator/src/observability/trace.ts` — campo missionId en TraceEntry
- `scripts/e2e-smoke.ts` — mock de mensajes FHS en CI
- `scripts/demo-failover-ocr.ts` — demo con mensajes FHS

NO afecta: `apps/atlas`, `apps/portal-chat`, `apps/portal-tui`, `apps/log-agent`.

---

## Tareas

### TASK-REN-001 — Rename en apps/navigator

- ID: TASK-REN-001
- State: `done`
- Owner: rafex
- Archivos modificados:
  - `apps/navigator/src/providers/llm-gateway.ts`
  - `apps/navigator/src/providers/mcp-host.ts`
  - `apps/navigator/src/observability/trace.ts`
- Validation: ✅ `grep -rn "requestId" apps/navigator/src/` devuelve 0 resultados.
  `grep -rn "missionId" apps/navigator/src/` devuelve 34 ocurrencias (verificado 2026-08-02).

---

### TASK-REN-002 — Rename en scripts/ y docs/

- ID: TASK-REN-002
- State: `done`
- Owner: rafex
- Archivos candidatos:
  - `scripts/e2e-smoke.ts`
  - `scripts/demo-failover-ocr.ts`
- Validation: ✅ `grep -rn "requestId" scripts/` devuelve 0 resultados (verificado 2026-08-02).
  Docs del Core no referenciaban el campo directamente.

---

### TASK-REN-003 — Verificación typecheck/lint/test en el monorepo

- ID: TASK-REN-003
- State: `done`
- Owner: rafex
- Dependencies: TASK-REN-001, TASK-REN-002
- Close criteria: `npm run typecheck && npm run lint && npm run test` limpios en el monorepo
  completo. El job `e2e-smoke` del CI pasa con los mensajes usando `missionId`.
- Validation: ✅ Monorepo migrado en commit `683ca9d feat: migrar apps runtime desde galaxIA`.

---

### TASK-REN-004 — Commit, push y PR

- ID: TASK-REN-004
- State: `done`
- Owner: rafex
- Dependencies: TASK-REN-003
- Validation: ✅ El rename ya está incluido en la migración inicial del monorepo Core.
  Ver commit `683ca9d` (main branch, 2026-08-02).

---

## Notas de coordinación

El rename `requestId → missionId` es un **flag-day de wire protocol**. Para que dos nodos se
comuniquen, ambos deben usar el mismo nombre de campo. El orden de redeploy recomendado:

1. Actualizar galaxIA-SDK (packages/fhs-protocol) — fuente de tipos compartidos
2. Actualizar galaxIA-Core (Navigator) — consume fhs-protocol
3. Actualizar galaxIA-satellite-star (Star, Satellite, Nova providers)
4. Reiniciar Bastion (Navigator + Star), Raspi4B (Satellite-OCR) simultáneamente
   para minimizar la ventana de incompatibilidad

Ver DEC-0085 en `spec-native/DECISIONS.md` del repo galaxIA-SDK (fuente de verdad de decisiones
del ecosistema).
