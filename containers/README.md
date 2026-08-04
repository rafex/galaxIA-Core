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
| Frontend | https://localhost:8443 | Portal HTTPS-only; el chat usa libp2p/WSS |
| Atlas/Navigator | libp2p `/ws` y `/tls/ws` | Bootstrap, DHT, GossipSub y streams FHS |

### 3. Conectar llama.cpp

Si tienes `llama-server` corriendo en el Bastion (por ejemplo `192.168.1.139:43110`), el Star lo consume como excepción local del modelo:

```bash
npx tsx scripts/mock-providers.ts
```

O edita el script para apuntar a tu llama-server real.

El portal requiere una o varias multiaddrs `.../tls/ws` de bootstrap del
Navigator en `FHS_NAVIGATOR_BOOTSTRAP_ADDRS` al arrancar el contenedor,
separadas por comas o saltos de línea. La configuración se genera como un
archivo estático servido por HTTPS; no se incrusta en la imagen. No se debe
fijar `/p2p/<PeerID>` en el frontend:
libp2p aprende la identidad durante Identify/Noise y la sesión se autentica
con el handshake FHS firmado. El certificado del portal es autofirmado y debe
aceptarse explícitamente en el navegador.

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
