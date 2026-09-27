# Histórico de incidencias del E2E

Fecha de actualización: 2026-09-26
Alcance: Portal Chat, Navigator, Atlas y proveedor OCR Satellite Star.

Este documento conserva los fallos observados durante las pruebas E2E de la
MVP, su causa técnica conocida, la corrección aplicada y el estado de la
validación. El objetivo es evitar que un mensaje genérico del portal o una
caída de infraestructura borre el contexto del diagnóstico.

## Estado actual

**2026-09-26** — Stack completo levantado en la red soberana
(`192.168.1.0/24`), ya con los 4 hosts y el Mac cliente en la misma red:
Bastion (Atlas + Navigator + Star + `llama-server`), Raspi4B
(`satellite-ocr`), Raspi3B (`kb-provider` + `rag-provider`) y la ThinkPad
(`192.168.1.239`, nueva) como host definitivo de `portal-chat` — reemplaza el
despliegue temporal en Bastion. Mesh convergido en 12 s (`peerCount: 5`). Se
corrigió además que nada sobreviviera a un reinicio (E2E-024).

**2026-08-30** — Instalación real desde imágenes de contenedor (Node.js 24,
`docs/distribucion-imagenes.md`) en topología de 3 hosts físicos: Bastion
(Atlas + Star + Navigator), Raspi4B (`satellite-ocr`) y una Raspi3B nueva,
"portal-pi" (`kb-provider` + `rag-provider`). La antigua Laptop
(MacBook Pro Debian 13) queda dada de baja — el frontend `portal-chat`
se instalará más adelante en una cuarta máquina todavía no conectada.

Los 5 nodos P2P confirmaron mesh completo: Atlas reporta `peerCount: 5` en
`/status` y ninguno de los 5 vuelve a emitir `PublishError.NoPeersSubscribedToTopic`
tras el primer ciclo de `NodeAdvertise` (ver E2E-021, E2E-022, E2E-023 para
las tres causas encontradas y corregidas durante esta instalación). Falta la
verificación E2E de un chat real de punta a punta — Navigator ya no expone
`/api/chat` por HTTP, solo un stream libp2p/protobuf, así que esa prueba
depende del frontend pendiente.

El apagado anterior de la Raspberry Pi (2026-08-05) queda registrado como una
incidencia de infraestructura: desde Bastion se observó `No route to host`
hacia `192.168.1.167:4003` y el vecino ARP apareció como `FAILED`. Durante ese
estado era esperable que Navigator informara que no había proveedores OCR
disponibles. Tras recuperarla, la prueba funcional del 2026-08-05 ejecutó
desde el navegador un PDF, una pregunta inicial y una pregunta de seguimiento
en el mismo chat; OCR, respuesta del LLM y `DocumentContext` pasaron.

## Resumen cronológico

| ID | Síntoma observado | Causa / diagnóstico | Corrección | Estado |
| --- | --- | --- | --- | --- |
| E2E-001 | La red mostraba `unknown` en lugar de la versión del despliegue. | Los `version.json` generados por el hook no quedaban sincronizados con el commit publicado. | El hook sobreescribe y agrega los `version.json` de Atlas, Navigator y Portal Chat; se conservaron en el repositorio junto con los commits de versión. | Resuelto; pendiente comprobar visualmente cada despliegue nuevo. |
| E2E-002 | El portal se servía sin cifrado y el navegador mostraba “No seguro”. | El portal estático no estaba publicado de forma coherente con la política HTTPS de la MVP. | Portal HTTPS con certificado autofirmado persistente; los mensajes siguen usando libp2p y protobuf. La confianza del certificado se instala manualmente en el navegador. | Mitigado. mTLS permanece en backlog. |
| E2E-003 | `The connection gater denied all addresses in the dial request`. | El peer anunciaba direcciones que el navegador no podía marcar como válidas o alcanzar; también faltaban reglas de red durante el despliegue. | Se corrigieron direcciones anunciadas/configuración dinámica y se habilitó el puerto P2P correspondiente, principalmente `4010/tcp` para Navigator. | Resuelto en configuración; se debe repetir tras cualquier cambio de red. |
| E2E-004 | Firefox no podía conectar a `wss://192.168.3.175:4010/`. | Endpoint WSS de Navigator no accesible, certificado no montado/confiado o firewall cerrado. | Certificados TLS montados en el contenedor, `NODE_EXTRA_CA_CERTS` configurado, escucha/anuncio en `4010` y reglas UFW revisadas. | Resuelto en despliegue; el certificado autofirmado aún requiere confianza local. |
| E2E-005 | La UI mostraba `[object Event]`. | Se convertía directamente un objeto de evento del navegador a texto. | Normalización de errores en Portal/API para extraer `message`, `reason` y código útil. | Resuelto. **Corrección 2026-09-26:** el normalizador nunca llegó al portal (todo error pasaba por `String(error)`); se implementó en E2E-025. |
| E2E-006 | La UI mostraba `[object ErrorEvent]`. | Mismo problema de serialización, esta vez procedente de WebSocket/WSS. | Manejo común de `Error`, `ErrorEvent`, eventos y valores desconocidos; el portal conserva el mensaje diagnosticable. | Resuelto. **Corrección 2026-09-26:** el normalizador nunca llegó al portal (todo error pasaba por `String(error)`); se implementó en E2E-025. |
| E2E-007 | `Falta VITE_FHS_NAVIGATOR_MULTIADDR o fhs.navigator.multiaddr`. | El portal no recibió la dirección P2P de Navigator y dependía de una configuración ausente. | Configuración de bootstrap/multiaddrs mediante variables y discovery dinámico; se elimina la dependencia de un valor duro en el cliente. | Resuelto en código; un despliegue sin configuración válida debe fallar explícitamente. |
| E2E-008 | `[P2P_CONNECT] Incorrect length`. | Desacuerdo en el framing del stream o intento de decodificar un frame incompleto/no FHS como protobuf. | Se homogeneizó el framing length-prefixed y la decodificación de envelopes protobuf; se añadieron pruebas del wire. | Resuelto en código; requiere validación E2E completa. |
| E2E-009 | `Cannot read properties of undefined (reading 'fields')`. | Un valor dinámico protobuf no tenía la estructura `DynamicObject.fields` esperada. | Se endureció la conversión de valores dinámicos: objetos usan `fields` y valores nulos/indefinidos se rechazan con error explícito. | Resuelto en código; no reproducido en la última prueba. |
| E2E-010 | `No hay modelos disponibles con tool calling en tu scope`. | Discovery no encontró un proveedor/modelo LLM compatible con el scope y la capacidad de tool calling. | Resolución dinámica de proveedores/modelos y diagnóstico explícito de scope/capacidades, sin seleccionar un proveedor por nombre fijo. | Condicionado al despliegue del proveedor LLM y sus anuncios. |
| E2E-011 | `No hay proveedores de OCR disponibles en tu scope`. | Navigator no tenía un peer OCR disponible en el scope; la Raspberry estaba caída o no había anunciado su beacon. | Discovery P2P por capacidades/beacons y comprobación de disponibilidad antes de invocar la herramienta. | Resuelto y verificado en la E2E funcional: Satellite anunció su beacon y procesó el PDF. |
| E2E-012 | `No se pudo procesar el archivo adjunto` al subir un PDF. | Navigator resolvía la capacidad `document.ocr`, pero podía invocar ese identificador en vez del nombre real anunciado por Satellite (`extract_text`). El error del proveedor también se perdía y terminaba como mensaje genérico. | `P2pMcpHost` usa el nombre anunciado mediante tags `tool:*`; `AgentRuntime` devuelve `{text,error}` y Portal conserva el código/mensaje real. | Resuelto y verificado con PDF real por la E2E funcional. |
| E2E-013 | PDF rechazado con `Incorrect length` o sin respuesta del LLM. | Se combinaban el problema de framing P2P y la disponibilidad/resolución del proveedor OCR; sin texto extraído no podía continuar el agente. | Corrección del wire protobuf, soporte de PDF en OCR y propagación de errores; Satellite procesa primero texto PDF y usa raster/OCR cuando es necesario. | Resuelto y verificado: OCR, respuesta inicial y pregunta de seguimiento completadas. |
| E2E-014 | `No se pudo conectar a ningún bootstrap P2P: ... 192.168.1.139:4001`. | Atlas no era alcanzable desde el navegador/Navigator o no tenía disponible el listener TLS/WSS en `4001`. | Verificación de listener, firewall, certificados y multiaddr de bootstrap; Navigator se despliega con la dirección configurada, no con una ruta inventada por la UI. | Resuelto en configuración conocida; validar con Atlas activo. |
| E2E-015 | Las solicitudes fallidas quedaban sin reintento cómodo. | El cliente no tenía una política de reconexión/reenvío asociada al mismo chat. | Reintentos automáticos con backoff y botón de fallback `↻ Reconectar` dentro del chat; se mantiene el mensaje fallido para reintentarlo. | Implementado; requiere prueba de caída/reconexión. |
| E2E-016 | El usuario no podía recorrer prompts anteriores con las flechas. | El input no mantenía un índice de historial de prompts. | Historial local del chat con `↑/↓`, separado por conversación y sin enviar ese historial automáticamente por P2P. | Implementado. |
| E2E-017 | El OCR se mostraba, pero `Usar documento` no continuaba con la pregunta original. | Navigator emitía `ocr.extracted` antes de insertar el adjunto en `pendingAttachments`; además, el Portal usaba un `conversationId` global en vez del `missionId` del evento. | Se registró el estado antes de emitir el evento y se corrigió la correlación por `missionId`. Esta solución intermedia quedó reemplazada por E2E-018. | Resuelto y superseded por el flujo automático. |
| E2E-018 | La vista OCR mostraba botones de confirmación y el texto incluía `type`, `missionId`, `toolCallId` y `result`. | El flujo seguía esperando una decisión humana aunque el prompt ya acompañaba al archivo; además, Navigator exponía el sobre del resultado de herramienta. | OCR se ejecuta automáticamente cuando el adjunto lleva prompt; el texto se guarda temporalmente en el frontend para las siguientes preguntas del mismo chat; la vista solo muestra `result`; se eliminan `Usar documento` y `Descartar`. | Resuelto y verificado en la E2E funcional PDF → pregunta inicial → seguimiento. |
| E2E-019 | La prueba Playwright no podía pulsar `Enviar` en la pregunta de seguimiento. | El tour de bienvenida aparecía de forma asíncrona y su overlay interceptaba el botón. | La prueba marca `galaxia-tour-completed` solo en su contexto aislado de navegador; no cambia la UX de producción. | Resuelto y verificado. |
| E2E-020 | El descubrimiento P2P probaba Atlas y las direcciones de Navigator una por una. | El failover secuencial añadía latencia y hacía depender la conexión del orden configurado. | El portal marca todos los bootstraps simultáneamente, conserva las conexiones exitosas en el swarm y marca en paralelo las direcciones firmadas de los Navigators. | Resuelto en código; falta validar con varios Atlas/Navigators activos. |
| E2E-021 | Build de `apps/navigator` fallaba en limpio con `Property 'chunks' does not exist on type 'DocumentContext'` (y `documentId`, `ragSource`, `RagSource` similares). | `apps/atlas`, `apps/navigator`, `apps/portal-chat` y `apps/portal-tui` seguían fijados en `@rafex_labs/galaxia-fhs-protocol@^0.1.35` mientras el `package.json` raíz ya pedía `^0.1.36` — con el alias `npm:` y rangos distintos por workspace, `npm install` resolvía la versión más baja (0.1.35, sin los campos RAG nuevos) en vez de 0.1.36. | Se alinearon los 4 `package.json` a `^0.1.36` (commit `03aaf0e`); con todos los workspaces en el mismo rango npm resuelve 0.1.36 de forma consistente. | Resuelto y verificado: build limpio de los 4 componentes en Bastion tras el fix. |
| E2E-022 | `bash containers/build-images.sh` se colgaba indefinidamente en Raspi4B durante `npm install` dentro del contenedor (sin salida, sin error). | UFW en Raspi4B bloqueaba el tráfico de salida del bridge de podman hacia DNS/registry — el build de `satellite-ocr` no podía resolver `registry.npmjs.org` desde dentro del contenedor. | Se reintentó tras confirmar reglas UFW existentes (rango `4000-4100`/`8080-8099` ya cubría los puertos P2P; el problema era saliente, no entrante) — el build nativo en Raspi4B completó en un segundo intento tras reiniciar el proceso en background correctamente detached (`nohup ... < /dev/null &`, ver E2E-014-style de SSH). | Resuelto; imagen `galaxia-satellite-ocr` construida y corriendo. |
| E2E-023 | `PublishError.NoPeersSubscribedToTopic` sostenido en los logs de GossipSub de Star y Navigator, minutos después del arranque — pero **no** en satellite-ocr/kb-provider/rag-provider (otros hosts). `curl .../status` en Atlas mostraba `peerCount: 3` en vez de 5: faltaban exactamente los dos peers co-ubicados en el mismo host que Atlas. | Hairpin NAT en podman rootless (pasta/slirp4netns): Atlas anuncia al swarm su IP externa real (`192.168.1.139`, necesaria para peers de otros hosts) — un contenedor del **mismo host** no puede dialear esa IP externa publicada de un contenedor hermano; la implementación de red rootless no soporta ese hairpin. | Atlas, Star y Navigator (todos en Bastion) se redesplegaron con `--network host` / `network_mode: host` en vez de publicar puertos con `-p`; esto evita el NAT por completo. Aplicado también en los 4 providers de `galaxIA-satellite-star/containers/compose*.yaml` para cubrir cualquier topología donde terminen co-ubicados con Atlas. | Resuelto y verificado: `peerCount: 5` estable, 0 recurrencias de `NoPeersSubscribedToTopic` en Star/Navigator tras el redeploy. |
| E2E-024 | Tras reiniciar Bastion y las Raspis (2026-09-26), **ningún** contenedor `fhs-*` volvió solo: todos en `Exited`, y `llama-server` tampoco corría. | Dos fallas que se suman: (1) `podman-restart.service` estaba deshabilitado; (2) aun habilitado, su `ExecStart` es `podman start --all --filter restart-policy=always`, y todos los contenedores se crearon con `unless-stopped` — nunca serían arrancados. `llama-server` corría con `nohup`, sin supervisor. | `podman update --restart always` en todos los `fhs-*` (sin recrear: se conservan identidades y volúmenes); `systemctl [--user] enable podman-restart.service` en los 4 hosts; `loginctl enable-linger rafex` en la ThinkPad (rootless); `llama-server` como unidad `systemd --user` en Bastion. Los `compose*.yaml` de `galaxIA-Core` y `galaxIA-satellite-star` pasan a `restart: always`. | Resuelto en configuración; pendiente confirmar con un reinicio real de cada host. |
| E2E-025 | Primera prueba real desde el navegador del Mac: "hola" quedó reintentando y el portal dijo "No se descubrió un Navigator activo". Del lado servidor no había ni un log: hubo que buscar un `TIME-WAIT` con `ss` en Bastion para ver que el navegador sí había intentado conectarse a `:4010`. | Firefox rechazó el certificado autofirmado de Navigator (la excepción se guarda por host **y puerto**; solo se había aceptado la de `:4001`). El error del dial se tragaba en `p2p-discovery.ts` (`catch {}`) y el timeout siempre decía "no se descubrió", aunque Navigator sí se había descubierto. Además: el handshake no tenía timeout, la etiqueta de conexión descartaba el motivo, no existía el normalizador de errores (ver E2E-005/006), el bootstrap de Navigator y de 3 providers era de un solo intento silencioso, y ningún servidor registraba conexiones (el rechazo TLS ocurre antes de que libp2p cree la conexión, así que solo lo veía el logger interno de libp2p, apagado). | Tres capas, ver [`diagnostico.md`](diagnostico.md): (1) panel "Diagnóstico de red" en el portal: etapas, ✓/✗ por dirección, enlace para aceptar cada certificado, "Copiar diagnóstico", normalizador `describeError`, timeout de handshake de 10 s, mensajes de timeout según la etapa real; (2) servidores: `dialBootstraps` con reintento y log, registro de conexiones, `DEBUG=libp2p:*:error` por defecto (muestra `TLS client error`), `/status` en Navigator y `/status` enriquecido en Atlas, fin del falso `[dht] beacon publicado`; (3) `galaxIA-gitops/scripts/doctor.sh`, que verifica TCP/TLS/SAN/reloj/malla desde la máquina de la demo. | Implementado con tests; pendiente de reproducir el fallo en Firefox tras el redeploy. |
| E2E-026 | Con la red ya en 5/5 y los certificados aceptados, el chat seguía "reintentando". El panel mostraba "Conectado a Navigator" y enseguida un reintento; antes, `ConnectionClosedError: The connection muxer is "closing"`. Navigator registraba "conexión cerrada (duró 0 s)". | Bug del portal desde agosto que no se notaba: `discoverNavigator` marca en paralelo todas las direcciones anunciadas y cierra las conexiones "sobrantes" que llegan después de elegir una. Pero libp2p **reutiliza la conexión existente** cuando ya hay una con ese peer, así que el segundo dial devolvía la misma conexión y el portal cerraba la que acababa de elegir. Se destapó con `--network host` (E2E-023): Navigator pasó a anunciar todas sus IPs, y varias (`.1.139`, `.3.143`, `.3.175`) son alcanzables desde el Mac. Además, el fallo de `newStream` no quedaba en el panel. | Solo se cierra una conexión tardía si es distinta de la elegida. Las direcciones de loopback anunciadas ya no se marcan desde otro equipo. El error al abrir la sesión se registra en el panel (etapa `session`). Test de regresión en `p2p-discovery-failures.test.ts`. | Corregido; pendiente de probar en Firefox. |
| E2E-027 | Con todo en verde (`doctor.sh` sin bloqueantes), adjuntar un PDF fallaba: "No se pudo procesar el archivo adjunto: [object ErrorEvent]". Navigator registraba `dial failed to /ip4/127.0.0.1/tcp/4003/…`. | Navigator marcaba solo `bid.providerMultiaddrs[0]`. Con `--network host` (E2E-023) cada provider anuncia todas sus IPs y la primera es 127.0.0.1: desde Bastion eso es Bastion, no la Raspi4B. Star funcionaba solo porque vive en el mismo host. Además, el error del WebSocket (un `ErrorEvent`, no un `Error`) llegaba al usuario como `String(err)`. | `dialProvider` en `nav-node.ts`, usado por los gateways de chat y tools: prueba las multiaddrs en orden (primero las de red, loopback al final) y, si todas fallan, dice qué pasó con cada una. `errorMessage` de `fhs-node` en lugar de `String(err)` en `runtime.ts` y `portal-session.ts`. Tests en `dial-provider.test.ts`. | Corregido; pendiente de desplegar y probar en el navegador. |
| E2E-028 | Con la recomendación de KB mejorada (`54fb599`) y la descripción de la KB ampliada, "¿Qué dice el artículo 3 sobre la educación?" seguía respondiéndose sin la KB. | Tres huecos entre la spec y el camino P2P: (1) `listKbProviders` buscaba la capability `kb.query` (SPEC-KB-0001) pero el kb-provider P2P anuncia `knowledge.query`, así que la lista de KBs siempre salía vacía; (2) `P2pAtlasClient` copiaba de cada capability solo el `id`, sin la descripción ni las etiquetas del beacon, así que no había texto contra qué comparar; (3) `P2pMcpHost.callTool` deducía la capability del nombre de la tool y no conocía `kb_query` ni `document_index`, así que la misión habría pedido una capability que nadie anuncia. | `KB_CAPABILITY_IDS` acepta `knowledge.query` y `kb.query`. `P2pAtlasClient` lleva a cada capability la descripción (de la capability o del proveedor) y las etiquetas del beacon, y usa el nombre del proveedor en vez del DID. `callTool` usa la capability real que el runtime ya pasa en `TraceContext` y deja la deducción por nombre como respaldo (ahora con `kb_query` y `document_index`). Tests en `p2p-atlas-client.test.ts`, `p2p-mcp-host.test.ts` y `kb-matching.test.ts`. | Corregido; pendiente de desplegar y probar en el navegador. |
| E2E-029 | Ya con la KB recomendada y confirmada ("✓ Usando KB Provider FHS", la KB respondió 1 fragmento), la respuesta sobre el artículo 3 se basó en el PDF de códigos de respaldo de la conversación, no en la Constitución. | (1) El kb-provider P2P devuelve el arreglo de fragmentos tal cual; Navigator esperaba `{ chunks }`, así que `parsed.chunks` era undefined, no se indexaba nada en el RAG y `queryMultipleKbs` devolvía null: el texto de la KB nunca llegaba al prompt. (2) Aunque llegara, iba al principio del mensaje y los fragmentos del documento (el RAG local del portal adjunta siempre sus 4 más cercanos, sin umbral) quedaban junto a la pregunta. | `kbChunksFrom` acepta el arreglo y `{ chunks }`. Si no hay rag-provider para fusionar o el indexado falla, los fragmentos de la KB se usan tal cual. La KB va justo antes de la pregunta, etiquetada como la base elegida, y el prompt de sistema pide apoyarse en los fragmentos relacionados e ignorar los que no. Pendiente aparte: umbral de relevancia en el RAG local del portal. | Corregido; pendiente de desplegar y probar en el navegador. |
| E2E-030 | Encontrado al evaluar la migración a `galaxIA-agent`: aunque Star ya transmite en vivo (`7d7c0bf`), el navegador recibía la respuesta completa al final. Además, con varios proveedores, `llm.selected` y la procedencia podían nombrar a un nodo y ejecutar otro, y el selector de KB por LLM habría mostrado su JSON (`{"kbId": …}`) en el chat. | `P2pLlmGateway` acumulaba los `chatDelta` y no los reenviaba; `callLlm` emitía un solo `assistant.delta` con todo el texto, también en llamadas internas. `P2pLlmGateway.generate` y `P2pMcpHost.callTool` ignoraban el proveedor elegido: cada llamada volvía a subastar y ganaba "el mejor bid". | Los `chatDelta` se reenvían al portal en llamadas sin tools (con tools se emite al final, para no mostrar texto de un turno que termina en tool call). `callLlm(..., emitAnswer=false)` para el selector de KB. `selectWinningBid`: el proveedor elegido gana si pujó; los gateways devuelven el DID que ejecutó y la procedencia lo usa. Tests en `mission-cycle.test.ts` y `runtime-streaming.test.ts`. | Corregido; pendiente de probar en el navegador. |
| E2E-031 | Encontrado al portar el runtime a `galaxIA-agent`: con RAG de red activo, los fragmentos del documento indexado nunca llegaban al prompt; las respuestas se apoyaban solo en la KB o en nada. | `queryRagContext` esperaba `{chunks: [...]}`, pero `rag_query` devuelve un arreglo. `parsed.chunks` era `undefined` y la función devolvía `null` sin error. | `queryRagContext` usa `kbChunksFrom`, que acepta arreglo o `{chunks}` (el mismo que ya usaba la consulta de KB). | Corregido; pendiente de desplegar. |
| E2E-032 | Encontrado con la prueba `tests/e2e` del portal: el Portal nunca obtenía el beacon del Navigator desde el DHT; cada conexión esperaba 3 s y seguía con las direcciones del anuncio GossipSub. Pasaba igual con el Navigator TS y con `galaxIA-agent`, y el put del beacon del Navigator TS agotaba sus 5 s. | `@libp2p/kad-dht` usa por defecto `peerInfoMapper: removePrivateAddressesMapper`: descarta las direcciones privadas de cada par. Toda la red FHS está en `192.168.1.0/24`, así que Atlas nunca entraba en la tabla de rutas y cada consulta se quedaba en `routing table was empty, waiting for some peers`. `galaxIA-agent` (rust-libp2p) no filtra y su put sí llegaba a Atlas. | `peerInfoMapper: passthroughMapper` en el Portal, en `fhs-node` (Atlas) y en el Navigator TS. La prueba `tests/e2e` lee el beacon firmado del agente Rust en ~1 s, recién conectada a Atlas. Pendiente: el mismo cambio en los providers de `galaxIA-satellite-star` (sus beacons DHT no los consulta nadie hoy). | Corregido. |
| E2E-033 | Al compilar las imágenes Rust de KB, RAG y OCR en la Raspi4B, `apt-get update` se colgaba dentro del contenedor y fallaba `Unable to locate package protobuf-compiler`. | Los contenedores de la Raspi4B (red por defecto de podman) usan `nameserver 192.168.3.1`, el router de la red Netup anterior; el host resuelve bien con la red soberana. Las imágenes TS ya estaban compiladas y no se había notado. | Compilar con `podman build --network host`. Pendiente del operador: corregir el DNS de los contenedores en la Raspi4B (`containers.conf` o el `resolv.conf` que toma podman). | Rodeado. |
| E2E-034 | Tras cambiar Atlas a Rust, la prueba `tests/e2e` no encontró el beacon del Navigator en el DHT. | Atlas guarda los registros del DHT en memoria y los pierde al reiniciar; el Navigator solo republicaba su beacon cada 30 min (el TS, solo al arrancar). | `galaxia-fhs` `f566295`: al reconectarse a un bootstrap el nodo vuelve a publicar su beacon de inmediato. Verificado reiniciando Atlas: republicado en 4 s y las 5 pruebas en verde. | Corregido. |
| E2E-035 | El Portal tardaba hasta 17 s en encontrar al Navigator (medido: 17.0 s y 1.2 s con el Atlas TS) y a veces agotaba su límite de 20 s. | Al conectarse a Atlas el Portal esperaba el siguiente anuncio periódico del Navigator (cada 30 s); GossipSub solo reentrega los mensajes de los últimos ~3 s. | `galaxia-fhs` `8a53140`: Atlas guarda el último anuncio firmado de cada DID y lo reenvía a cada suscriptor nuevo (los bytes originales; la firma sigue siendo del emisor). Con Atlas Rust: 1.09 s y 1.12 s. | Corregido. |

## Detalle de la corrección OCR

El incidente E2E-012 fue el fallo de código más importante encontrado en la
última prueba:

1. Satellite Star anuncia la capacidad `document.ocr` y la herramienta real
   `extract_text` mediante su beacon.
2. Navigator cargaba la capacidad, pero construía el nombre de llamada a
   partir del identificador de capacidad (`document.ocr`).
3. Satellite rechazaba la llamada porque esperaba `extract_text`.
4. Navigator devolvía `null` y Portal Chat lo convertía en el mensaje genérico
   de adjunto fallido.

La corrección hace que Navigator invoque el nombre descubierto en los tags
`tool:*` y preserve el error del proveedor. Las funciones relevantes son:

- `apps/navigator/src/p2p/p2p-mcp-host.ts`: carga de herramientas y llamada por
  nombre anunciado.
- `apps/navigator/src/agent/runtime.ts`: resultado estructurado de OCR y
  diagnóstico.
- `apps/navigator/src/p2p/portal-session.ts`: propagación del código/mensaje al
  Portal Chat.
- `apps/navigator/src/p2p/__tests__/p2p-mcp-host.test.ts`: pruebas del nombre
  descubierto.

La cadena de commits asociada incluye:

- `571ee5f fix: invoke OCR tools by discovered name`;
- `e677f39 fix: preserve OCR provider failure details`;
- `6b78313` y `3740cfc`, que actualizan la metadata de versión del despliegue.

## Incidencias de infraestructura frente a incidencias de código

No deben mezclarse estos casos:

- `No hay proveedores de OCR disponibles` puede ser correcto si Satellite no
  está encendido, no tiene red o no ha anunciado el beacon.
- `No se pudo procesar el archivo adjunto` con un error concreto del proveedor
  indica que el discovery ya llegó a un peer, pero la herramienta falló.
- `No se pudo conectar al bootstrap` indica una falla de alcance de Atlas o de
  su endpoint P2P, antes de resolver modelos/herramientas.
- `No hay modelos disponibles con tool calling` indica discovery/scope de LLM,
  no necesariamente que `llama.cpp` esté caído.

## Validación al recuperar la Raspberry Pi

Desde Bastion:

```bash
ping -c 3 192.168.1.167
ssh raspi4b 'podman ps --format "table {{.Names}}\\t{{.Status}}\\t{{.Ports}}"'
ssh raspi4b 'podman logs --tail 100 <contenedor-ocr>'
nc -vz 192.168.1.167 4003
```

Después hay que comprobar, en los logs de Navigator, el anuncio del peer con
`document.ocr` y `tool:extract_text`. Finalmente se debe adjuntar un PDF desde
Portal Chat y verificar esta secuencia:

1. aparece el proveedor OCR descubierto;
2. se invoca `extract_text` por libp2p;
3. llega el texto OCR o un error concreto del proveedor;
4. el modelo recibe el contexto y devuelve la respuesta;
5. una caída posterior permite reconexión automática y, si se agota el backoff,
   muestra `↻ Reconectar` en el mismo chat.

## Política de transporte

El historial de incidencias respeta la definición del protocolo: los mensajes,
discovery, llamadas de herramientas, OCR y LLM viajan por libp2p con payloads
protobuf. HTTPS sirve únicamente los estáticos del portal; WSS/TLS es el
transporte que el navegador necesita para alcanzar el peer libp2p. No se usa
HTTP/SSE como canal alternativo de mensajes. La adopción de mTLS queda como
pendiente de seguridad y no cambia la regla libp2p-first.
