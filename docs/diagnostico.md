# Diagnóstico de red

Cuando el chat se queda "reintentando", el problema casi siempre es de red:
un certificado autofirmado que el navegador no aceptó, un puerto cerrado, un
host que no se alcanza desde esa red o un reloj desfasado. Antes esos
errores se perdían en silencio (ver `E2E-025` en
[`historial-incidencias-e2e.md`](historial-incidencias-e2e.md)). Hoy hay tres
lugares donde mirar, del más cercano al usuario al más profundo.

## 1. Antes de abrir el navegador: `doctor.sh`

Desde la máquina que va a usar el portal (la laptop de la demo):

```bash
galaxIA-gitops/scripts/doctor.sh https://<host-del-portal>:8443
EXPECTED_PEERS=5 galaxIA-gitops/scripts/doctor.sh https://<host-del-portal>:8443
```

Revisa el portal, cada bootstrap y cada dirección de Navigator (TCP, TLS,
SAN del certificado contra la IP marcada, vencimiento, autofirmado), el
desfase de reloj y la red vista por Atlas/Navigator. Da ✅/⚠️/❌ con una
pista por fila y termina con código 1 si hay algún ❌. Solo usa bash, curl y
openssl.

## 2. En el portal: panel "Diagnóstico de red"

Botón 🩺 del encabezado, o clic en el texto de estado de la conexión. El
botón se marca en rojo mientras el intento actual tenga un fallo.

- **Resumen**: en qué etapa se quedó el intento actual (sin bootstrap,
  conectado pero sin anuncio de Navigator, Navigator encontrado pero falló la
  conexión, handshake sin respuesta).
- **Conexiones del navegador**: cada `wss://` que intentó abrir, con ✓/✗, el
  motivo y, en cada fallo, **el enlace para aceptar el certificado** de ese
  host:puerto.
- **Eventos**: la línea de tiempo por etapa. También salen en la consola con
  el prefijo `[fhs-diag]`.
- **Copiar diagnóstico**: reporte en texto para compartir (versión, página,
  navegador, bootstrap y todos los eventos).

**Límite del navegador:** por seguridad, JavaScript no recibe el motivo de un
fallo TLS de un WebSocket. Un ✗ en un `wss://` puede ser certificado no
aceptado, puerto cerrado o host inalcanzable. La causa más común es la
primera: abre el enlace, acepta el riesgo y reconecta.

Para ver el detalle interno de libp2p en el navegador, en la consola:
`localStorage.debug = 'libp2p:*'` y recargar (la salida va a `console.debug`,
activa el nivel "Detallado").

## 3. En los servidores: logs y `/status`

**Logs** (`podman logs <contenedor>`), en Atlas, Navigator y los providers:

- `bootstrap no disponible (…): <motivo> — reintento N en X s` y luego
  `bootstrap conectado: … (intento N)`. El bootstrap se reintenta con backoff
  hasta conectar; antes era un solo intento silencioso.
- `conexión abierta ← / → <peer> <dirección>` y `conexión cerrada … (duró X s)`.
- Navigator: `[portal-session] sesión abierta: <did> desde <dirección>` y
  `sesión cerrada`, `stream sin handshake`.
- `mensaje descartado …` / `frame con firma inválida descartado …`: el primero
  de cada motivo y luego cada 50.
- **Errores internos de libp2p**: los Containerfiles traen
  `DEBUG=libp2p:*:error`. Así aparecen, por ejemplo,
  `libp2p:websockets:listener:error TLS client error`, que es lo que ve el
  servidor cuando un navegador rechaza su certificado. Todo el detalle:
  `-e DEBUG='libp2p:*'` (muy verboso). Apagar: `-e DEBUG=`.

**APIs de observabilidad** (HTTPS, solo LAN, no se tunelan):

| Endpoint | Qué muestra |
|---|---|
| `https://<atlas>:8081/status` | `peers`, `peerCount`, `connections` (peer, dirección, dirección de conexión, desde cuándo) y `pubsub` (suscriptores y malla por tópico) |
| `https://<navigator>:8090/health` | versión, `did` y `multiaddrs` |
| `https://<navigator>:8090/status` | lo mismo que Atlas más `knownPeers`: providers anunciados con su tipo, capacidades, direcciones y `lastSeen` |

Una malla vacía en `fhs/v1/nodes/advertise` es la señal de
`PublishError.NoPeersSubscribedToTopic`: el nodo no está conectado al resto.
