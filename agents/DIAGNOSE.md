# Diagnóstico del Proyecto

_Fecha: 2026-07-07 | Repositorio: galaxIA (FHS — Federation of Sovereign Horizons)_

---

## 1. Exploración

### Estructura general

```
galaxIA/
├── apps/
│   ├── atlas/          # Registry de proveedores con métricas (Fastify + SQLite)
│   ├── navigator/      # Agent Runtime + Chat API (Fastify + WebSocket)
│   └── portal/         # Frontend chat web (Vite + vanilla TypeScript)
├── packages/
│   └── fhs-protocol/   # Tipos y contratos del protocolo FHS
├── containers/         # Docker Compose + Containerfiles (atlas, navigator, portal)
├── spec-native/        # Documentación SpecNative (PRODUCT, ARCHITECTURE, STACK, DECISIONS, specs, tasks, workflows)
├── docs/               # Documentación de usuario/desarrollador
├── helpers/            # Scripts de desarrollo (shell, python)
├── examples/           # Providers de ejemplo (llm-provider, ocr-provider)
├── site/               # Sitio web público
└── scripts/            # Scripts auxiliares
```

### Lenguajes y tecnologías

- **TypeScript >=5.0** como lenguaje principal
- **Node.js >=20** como runtime
- **npm workspaces** como gestor de monorepo
- **Fastify** como framework backend (apps/navigator, apps/atlas)
- **Vite** como build tool del frontend (apps/portal)
- **WebSocket (ws)** para comunicación en tiempo real
- **SQLite (better-sqlite3)** para persistencia de métricas en atlas
- **Podman/Docker** para contenedores
- **Nginx** en el contenedor portal
- Sin frameworks frontend pesados (vanilla TypeScript + HTML5 + CSS3)

### Sistema de build / dependencias

- **npm workspaces** (monorepo con 5 package.json: raíz, apps/atlas, apps/navigator, apps/portal, packages/fhs-protocol)
- Scripts: `dev:web`, `dev:agent`, `build`, `lint`, `typecheck`
- **Just** task runner (helpers/just/) como alternativa a make
- **Makefile** presente pero secundario
- **No hay herramientas de CI/CD** configuradas (.github/workflows/ no existe)

### Puntos de entrada

| Archivo | Descripción |
|---------|-------------|
| `apps/atlas/src/index.ts` | Registry de proveedores (Fastify + WebSocket) |
| `apps/navigator/src/index.ts` | Agent Runtime / Chat API (Fastify + WebSocket) |
| `apps/portal/src/main.ts` | Frontend chat (Vite entry point) |
| `packages/fhs-protocol/src/index.ts` | Tipos y contratos exportados del protocolo FHS |

### Módulos y componentes clave

- **fhs-protocol**: contratos del protocolo (tipos de mensajes, manifiestos, registros). Sin lógica de red.
- **atlas (Registry)**: catálogo de nodos/servicios en memoria, métricas en SQLite, mDNS announce, validación de manifiestos, WebSocket handler para registro de providers. Submódulos: `atlas/metrics.ts`, `atlas/db.ts`, `atlas/registry.ts`, `atlas/ws-handler.ts`, `atlas/identity-store.ts`.
- **navigator (Agent Runtime)**: orquestador central — clasifica intención, resuelve LLM y tools desde Registry, ejecuta ciclo del agente. Submódulos: `agent/runtime.ts`, `providers/llm-gateway.ts` (habla FHS), `providers/mcp-host.ts` (tools vía FHS), `atlas-client.ts` (consulta al Registry), `api/chat-ws.ts`, `sse/event-bus.ts`.
- **portal (Frontend)**: interfaz de chat con selección de modelo y ámbito, visualización de procedencia.

### Archivos de configuración relevantes

| Archivo | Tipo |
|---------|------|
| `package.json` | Monorepo root con workspaces |
| `containers/compose.yaml` | Docker Compose principal |
| `containers/compose.tls.yaml` | Docker Compose con TLS |
| `.gitignore` | Exclusiones (node_modules, dist, .env, certs, identidades, SQLite data) |
| `.env` | Variables de entorno locales |
| `.containerignore` | Exclusiones de build de contenedores |
| `codex.toml` | Configuración de Codex |
| `AGENTS.md` | Contrato operativo para agentes IA |

### Estado del repositorio

- **Rama activa:** `main`
- **Otras ramas:** `fhs-protocol-dist`, `specnative/install-v0.7.0`
- **Último commit:** `18d6985` — "feat: implementar KbCitation — metadata de citación en resultados de kb.query (SPEC-KB-0003, DEC-0049)"
- **Working tree:** clean (sin archivos modificados)
- **14 specs** registradas en `spec-native/specs/`
- **1 spec activa:** `SPEC-AUTH-0001` (autenticación)

---

## 2. Revisión de calidad

### Problemas estructurales o de diseño

- **Sin CI/CD** — no existen workflows de GitHub Actions, lo que aumenta el riesgo de regresiones no detectadas en integración
- **Separación de capas débil** — en `apps/atlas/src/atlas/ws-handler.ts` la lógica de validación de mensajes y gestión de conexiones están mezcladas, dificultando pruebas unitarias
- **Uso de `any` en tipos críticos** — `Record<string, any>` en `ToolParameterSchema` (`packages/fhs-protocol/src/llm.ts:9`), casts a `any` en `ws-handler.ts:55`

### Deuda técnica identificada

- **40+ ocurrencias de `any`** en `apps/**/*.ts` — anula las garantías de TypeScript en componentes core
- **Validación incompleta de entradas** — el registro de providers en `ws-handler.ts` valida parcialmente el manifiesto pero no verifica la integridad de `toolCall.arguments`
- **Gestión de errores débil** — errores como `INVALID_SIGNATURE` se manejan con `send(... as any)` sin propagación estructurada

### Prácticas del lenguaje no seguidas

- Tipado incompleto en handlers de WebSocket (`raw: any`)
- Posible ausencia de `strictNullChecks`/`noImplicitAny` en tsconfig
- Dependencias sin versión fija (ej: `@fastify/websocket`)

### Riesgos de seguridad

- **Sin autenticación de usuarios** — `SPEC-AUTH-0001` bloqueado, lo que impide implementar funcionalidades que requieren identidad verificada
- **Firma Ed25519 sin validación anti-replay** — en `ws-handler.ts` la verificación de firmas no valida `timestamp` contra ataques de reenvío
- **Sin validación completa de toolCall.arguments** — riesgo de inyección o datos maliciosos en llamadas a tools

### Cobertura de tests y documentación

- **CERO tests** en todo el monorepo — no existen archivos `*.test.ts` ni `*.spec.ts`
- Componentes críticos sin cobertura: `atlas/db.ts`, `atlas/ws-handler.ts`, `navigator/agent/runtime.ts`, `fhs-protocol/llm.ts`
- 14 specs registradas pero solo 1 activa (`SPEC-AUTH-0001`); varias sin tareas vinculadas
- Documentación de `fhs-protocol` sin ejemplos de uso ni edge cases

---

## 3. Síntesis ejecutiva

### Resumen del proyecto

galaxIA es una prueba de concepto de chat comunitario federado que permite a usuarios descubrir, autenticar, seleccionar y consumir capacidades de IA distribuidas entre nodos soberanos mediante el protocolo FHS (Federation of Sovereign Horizons). El objetivo del MVP es demostrar que un grupo de personas puede combinar sus propios equipos —una Mac mini con llama.cpp, una laptop con OCR, una Raspberry Pi con whisper— en un único agente de IA usable desde una interfaz común.

El código está organizado como un monorepo npm workspaces con tres aplicaciones (atlas/registry, navigator/agent-runtime, portal/frontend), un paquete compartido (fhs-protocol) y configuración de contenedores Docker/Podman. Se emplean TypeScript >=5.0 y Node.js >=20. Los backends usan Fastify + WebSocket, el frontend usa Vite con TypeScript puro (sin React/Vue), y la persistencia se maneja con SQLite. No existen pipelines de CI/CD configurados.

### Estado de salud

**🟡 Amarillo** — Hay una arquitectura funcional, un stack moderno y documentación de contexto SpecNative bien estructurada. Sin embargo, la ausencia total de tests, la falta de CI/CD, el uso excesivo de `any` en tipos críticos y la seguridad incompleta (sin autenticación, validación débil de firmas) hacen que el proyecto sea vulnerable a regresiones y riesgos de seguridad conforme crezca.

### Top 3 fortalezas

1. **Arquitectura modular clara** — separación entre registry (atlas), agent runtime (navigator) y UI (portal) con un protocolo compartido (fhs-protocol), facilitando evolución independiente de cada capa
2. **Stack moderno y ligero** — TypeScript 5, Fastify, WebSocket y Vite sin frameworks pesados, alineado con el objetivo de mantener el PoC ligero y portable
3. **Documentación SpecNative bien estructurada** — 14 specs registradas con contexto de producto, arquitectura, stack, decisiones y trazabilidad, lo que permite onboarding rápido de nuevos agentes o desarrolladores

### Top 3 riesgos o deudas

1. **CERO tests en todo el monorepo** — ningún test unitario ni de integración; componentes críticos como el agent runtime, el registry y el protocolo no tienen cobertura alguna, haciendo imposible detectar regresiones
2. **Tipado inseguro (40+ `any`)** — uso excesivo de `any` en validación de mensajes, manejo de WebSocket y tipos del protocolo, anulando las garantías de TypeScript en el core del sistema
3. **Seguridad y CI/CD inexistentes** — sin autenticación de usuarios, sin validación anti-replay en firmas Ed25519, sin pipelines de CI que automaticen lint/typecheck/build, el proyecto es frágil ante cambios y vulnerable a ataques

### Próximos pasos recomendados

1. **Configurar CI/CD con GitHub Actions** — crear workflow que ejecute `lint`, `typecheck` y `build` en cada push/PR; es el paso de mayor impacto porque previene regresiones inmediatamente
2. **Eliminar `any` y reforzar tipado** — reemplazar `any` por `unknown` + type guards en `ws-handler.ts`, `llm.ts` y `mcp-host.ts`; habilitar `strict` en tsconfig para evitar nuevos usos de `any`
3. **Crear suite de tests inicial** — priorizar tests unitarios para `fhs-protocol` (tipos y validación) y tests de integración para el flujo registry → agent runtime → chat, cubriendo al menos registro de providers y ciclo de mensajería

---

## 4. Archivos relevantes

| Archivo | Tipo | Relevancia |
|---------|------|------------|
| `package.json` | config | Monorepo raíz — define workspaces, scripts y dependencias |
| `packages/fhs-protocol/src/llm.ts` | module | Tipos del protocolo LLM — contiene `Record<string, any>` que debe refinarse |
| `apps/atlas/src/atlas/ws-handler.ts` | module | Handler WebSocket del Registry — alta concentración de `any`, validación incompleta |
| `apps/atlas/src/atlas/db.ts` | module | Capa de persistencia SQLite — componente crítico sin tests |
| `apps/navigator/src/agent/runtime.ts` | module | Ciclo del agente — orquestador central, sin tests |
| `apps/navigator/src/providers/mcp-host.ts` | module | Ejecución de tools vía FHS — contiene `any`, gestión de errores débil |
| `apps/navigator/src/providers/llm-gateway.ts` | module | Gateway LLM vía FHS WebSocket — comunicación crítica con providers |
| `apps/portal/src/main.ts` | entry | Entry point del frontend (Vite) |
| `containers/compose.yaml` | config | Orquestación de servicios Docker/Podman |
| `.gitignore` | config | Exclusiones — cubre secrets, certs, datos, build artifacts |
| `spec-native/ARCHITECTURE.md` | docs | Arquitectura del sistema — fuente de verdad para estructura y flujos |
| `spec-native/DECISIONS.md` | docs | Decisiones de diseño persistentes — tradeoffs que condicionan el futuro |
| `spec-native/specs/SPEC-AUTH-0001/SPEC.md` | spec | Única spec activa — autenticación de usuarios, bloqueante para otras features |
| `AGENTS.md` | config | Contrato operativo para agentes IA que trabajan en el repo |
