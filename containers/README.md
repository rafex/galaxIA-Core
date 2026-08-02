# Contenedores FHS

Esta carpeta agrupa todos los artefactos de contenedorización del MVP FHS v0.1.

## Estructura

```
containers/
├── navigator/         # Agent Backend (Fastify + Registry/Atlas + Runtime)
├── portal-chat/        # Frontend web (Vite + Nginx)
├── ocr-mcp/          # Proveedor MCP OCR (Python + Tesseract)
├── llama-provider/   # Instrucciones para llama.cpp (nativo o contenedor)
└── compose.yaml      # Orquestación completa con Podman Compose / Docker Compose
```

## Uso rápido

### 1. Construir y levantar todo

```bash
cd containers
podman-compose up --build
```

O con Docker:

```bash
cd containers
docker compose up --build
```

### 2. URLs resultantes

| Servicio | URL local | Descripción |
|---|---|---|
| Frontend | http://localhost:3000 | Chat web FHS |
| Agent Backend | http://localhost:8081 | API REST + SSE + Registry WS |
| OCR MCP | http://localhost:8082/mcp | Servidor MCP OCR |

### 3. Conectar llama.cpp

Si tienes `llama-server` corriendo en otra máquina (por ejemplo `192.168.3.173:43110`), regístralo manualmente en el Registry:

```bash
npx tsx scripts/mock-providers.ts
```

O edita el script para apuntar a tu llama-server real.

## Desarrollo sin contenedores

Si prefieres desarrollar localmente:

```bash
# Terminal 1
npm run dev -w apps/navigator

# Terminal 2
npm run dev -w apps/portal-chat

# Terminal 3 (OCR)
cd containers/ocr-mcp
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
PORT=8082 REGISTRY_URL=ws://localhost:8081/fhs/v1/ws python ocr_server.py
```
