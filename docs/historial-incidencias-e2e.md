# Histórico de incidencias del E2E

Fecha de actualización: 2026-08-04
Alcance: Portal Chat, Navigator, Atlas y proveedor OCR Satellite Star.

Este documento conserva los fallos observados durante las pruebas E2E de la
MVP, su causa técnica conocida, la corrección aplicada y el estado de la
validación. El objetivo es evitar que un mensaje genérico del portal o una
caída de infraestructura borre el contexto del diagnóstico.

## Estado actual

El E2E está bloqueado temporalmente por infraestructura: la Raspberry Pi que
aloja el proveedor OCR está apagada. Desde Bastion se observó `No route to
host` hacia `192.168.1.167:4003`, y el vecino ARP aparece como `FAILED`. Por
tanto, mientras la Raspberry no vuelva a la red es esperable que Navigator
informe que no hay proveedores OCR disponibles. Esto no prueba un fallo de la
última corrección de descubrimiento; esa corrección debe validarse cuando el
proveedor vuelva a anunciarse por libp2p.

## Resumen cronológico

| ID | Síntoma observado | Causa / diagnóstico | Corrección | Estado |
| --- | --- | --- | --- | --- |
| E2E-001 | La red mostraba `unknown` en lugar de la versión del despliegue. | Los `version.json` generados por el hook no quedaban sincronizados con el commit publicado. | El hook sobreescribe y agrega los `version.json` de Atlas, Navigator y Portal Chat; se conservaron en el repositorio junto con los commits de versión. | Resuelto; pendiente comprobar visualmente cada despliegue nuevo. |
| E2E-002 | El portal se servía sin cifrado y el navegador mostraba “No seguro”. | El portal estático no estaba publicado de forma coherente con la política HTTPS de la MVP. | Portal HTTPS con certificado autofirmado persistente; los mensajes siguen usando libp2p y protobuf. La confianza del certificado se instala manualmente en el navegador. | Mitigado. mTLS permanece en backlog. |
| E2E-003 | `The connection gater denied all addresses in the dial request`. | El peer anunciaba direcciones que el navegador no podía marcar como válidas o alcanzar; también faltaban reglas de red durante el despliegue. | Se corrigieron direcciones anunciadas/configuración dinámica y se habilitó el puerto P2P correspondiente, principalmente `4010/tcp` para Navigator. | Resuelto en configuración; se debe repetir tras cualquier cambio de red. |
| E2E-004 | Firefox no podía conectar a `wss://192.168.3.175:4010/`. | Endpoint WSS de Navigator no accesible, certificado no montado/confiado o firewall cerrado. | Certificados TLS montados en el contenedor, `NODE_EXTRA_CA_CERTS` configurado, escucha/anuncio en `4010` y reglas UFW revisadas. | Resuelto en despliegue; el certificado autofirmado aún requiere confianza local. |
| E2E-005 | La UI mostraba `[object Event]`. | Se convertía directamente un objeto de evento del navegador a texto. | Normalización de errores en Portal/API para extraer `message`, `reason` y código útil. | Resuelto. |
| E2E-006 | La UI mostraba `[object ErrorEvent]`. | Mismo problema de serialización, esta vez procedente de WebSocket/WSS. | Manejo común de `Error`, `ErrorEvent`, eventos y valores desconocidos; el portal conserva el mensaje diagnosticable. | Resuelto. |
| E2E-007 | `Falta VITE_FHS_NAVIGATOR_MULTIADDR o fhs.navigator.multiaddr`. | El portal no recibió la dirección P2P de Navigator y dependía de una configuración ausente. | Configuración de bootstrap/multiaddrs mediante variables y discovery dinámico; se elimina la dependencia de un valor duro en el cliente. | Resuelto en código; un despliegue sin configuración válida debe fallar explícitamente. |
| E2E-008 | `[P2P_CONNECT] Incorrect length`. | Desacuerdo en el framing del stream o intento de decodificar un frame incompleto/no FHS como protobuf. | Se homogeneizó el framing length-prefixed y la decodificación de envelopes protobuf; se añadieron pruebas del wire. | Resuelto en código; requiere validación E2E completa. |
| E2E-009 | `Cannot read properties of undefined (reading 'fields')`. | Un valor dinámico protobuf no tenía la estructura `DynamicObject.fields` esperada. | Se endureció la conversión de valores dinámicos: objetos usan `fields` y valores nulos/indefinidos se rechazan con error explícito. | Resuelto en código; no reproducido en la última prueba. |
| E2E-010 | `No hay modelos disponibles con tool calling en tu scope`. | Discovery no encontró un proveedor/modelo LLM compatible con el scope y la capacidad de tool calling. | Resolución dinámica de proveedores/modelos y diagnóstico explícito de scope/capacidades, sin seleccionar un proveedor por nombre fijo. | Condicionado al despliegue del proveedor LLM y sus anuncios. |
| E2E-011 | `No hay proveedores de OCR disponibles en tu scope`. | Navigator no tenía un peer OCR disponible en el scope; la Raspberry podía estar caída o no haber anunciado su beacon. | Discovery P2P por capacidades/beacons y comprobación de disponibilidad antes de invocar la herramienta. | Abierto por Raspberry apagada; no ejecutar cierre hasta recuperar `192.168.1.167`. |
| E2E-012 | `No se pudo procesar el archivo adjunto` al subir un PDF. | Navigator resolvía la capacidad `document.ocr`, pero podía invocar ese identificador en vez del nombre real anunciado por Satellite (`extract_text`). El error del proveedor también se perdía y terminaba como mensaje genérico. | `P2pMcpHost` usa el nombre anunciado mediante tags `tool:*`; `AgentRuntime` devuelve `{text,error}` y Portal conserva el código/mensaje real. | Corrección publicada; E2E pendiente de la Raspberry. |
| E2E-013 | PDF rechazado con `Incorrect length` o sin respuesta del LLM. | Se combinaban el problema de framing P2P y la disponibilidad/resolución del proveedor OCR; sin texto extraído no podía continuar el agente. | Corrección del wire protobuf, soporte de PDF en OCR y propagación de errores; Satellite procesa primero texto PDF y usa raster/OCR cuando es necesario. | Pendiente de repetir con Satellite operativo. |
| E2E-014 | `No se pudo conectar a ningún bootstrap P2P: ... 192.168.1.139:4001`. | Atlas no era alcanzable desde el navegador/Navigator o no tenía disponible el listener TLS/WSS en `4001`. | Verificación de listener, firewall, certificados y multiaddr de bootstrap; Navigator se despliega con la dirección configurada, no con una ruta inventada por la UI. | Resuelto en configuración conocida; validar con Atlas activo. |
| E2E-015 | Las solicitudes fallidas quedaban sin reintento cómodo. | El cliente no tenía una política de reconexión/reenvío asociada al mismo chat. | Reintentos automáticos con backoff y botón de fallback `↻ Reconectar` dentro del chat; se mantiene el mensaje fallido para reintentarlo. | Implementado; requiere prueba de caída/reconexión. |
| E2E-016 | El usuario no podía recorrer prompts anteriores con las flechas. | El input no mantenía un índice de historial de prompts. | Historial local del chat con `↑/↓`, separado por conversación y sin enviar ese historial automáticamente por P2P. | Implementado. |

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
