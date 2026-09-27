# Agente soberano Rust/Rig

`galaxIA-agent` es la implementación Rust/Rig activa de Navigator, desplegada en
Bastion como servicio productivo. `apps/navigator/src/agent/runtime.ts` se
conserva en Core como referencia TypeScript histórica; no debe ejecutarse en
paralelo con Rust porque comparten identidad y puertos.

## Frontera

El agente Rust no conoce ni invoca `llama.cpp`. Su única ruta de generación es
un `CompletionModel` de Rig que serializa un `ChatRequestMessage` Protobuf y lo
envía a un Star mediante una Mission FHS. Atlas sigue siendo bootstrap/registry;
no es un proxy de la Mission.

## Política

Antes de construir mensajes para el modelo se genera un `RequestPlan`:

1. valida `conversationId`, `requestId` y el texto;
2. aplica el scope de privacidad y permite solo providers compatibles;
3. selecciona `local` o `network` como única fuente de RAG;
4. acepta únicamente fragmentos acotados de `DocumentChunk`;
5. limita el número de rondas de tools a tres y deduplica por `toolCallId`;
6. conserva la correlación de request, mission y provider para procedencia.

La oferta espera hasta el plazo de pujas configurado (2 s por defecto). Si el
runtime ya fijó un provider preferido, su bid cierra la espera tempranamente:
la política de selección ya le da prioridad, así que se ahorra espera sin
cambiar el ganador. Para ofertas sin provider preferido se recogen bids durante
la ventana completa para conservar la elección por confianza, reputación y
latencia. El agente registra `bid_wait_ms` por mission para medir el efecto.

El OCR completo nunca se concatena al prompt. La ruta local sigue en el Portal;
la ruta network usa `document.index` y `document.query` por Missions FHS.

## Construcción y operación

El repositorio independiente se construye como imagen Podman en Bastion:

```sh
podman build -t localhost/galaxia-agent:latest /ruta/galaxIA-agent
podman run --rm --network host -e GALAXIA_AGENT_BIND=0.0.0.0:8090 localhost/galaxia-agent:latest
```

No se instala nada en macOS. El corte de producción a Rust ya se realizó; esta
guía describe el estado operativo y no una migración pendiente. La ruta de
trabajo restante se centra en completar la base FHS compartida y migrar los
servicios backend por prioridad de latencia, con pruebas de interoperabilidad y
reversa en cada etapa. Consulta la
[guía de migración Rust/WASM basada en latencia](https://github.com/rafex/galaxIA/blob/main/docs/migracion-rust-rendimiento.md).

El agente productivo y sus pruebas están en
[`galaxIA-agent`](https://github.com/rafex/galaxIA-agent). El IDL que consume
está versionado y se compara con `galaxIA/idl/fhs-protocol.proto`. La ruta para
migrar Star, providers, OCR y Atlas, y medir el rendimiento sin atribuir la
inferencia a Rust, vive en
[`galaxIA/docs/migracion-rust-rendimiento.md`](https://github.com/rafex/galaxIA/blob/main/docs/migracion-rust-rendimiento.md).
