# Agente soberano Rust/Rig

`galaxIA-agent` es el reemplazo controlado de `apps/navigator/src/agent/runtime.ts`.
El runtime TypeScript sigue siendo la implementación activa hasta que el agente
Rust complete la compatibilidad de transporte y pase las pruebas E2E.

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

El OCR completo nunca se concatena al prompt. La ruta local sigue en el Portal;
la ruta network usa `document.index` y `document.query` por Missions FHS.

## Construcción y transición

El repositorio independiente se construye como imagen Podman en Bastion:

```sh
podman build -t localhost/galaxia-agent:latest /ruta/galaxIA-agent
podman run --rm --network host -e GALAXIA_AGENT_BIND=0.0.0.0:8090 localhost/galaxia-agent:latest
```

No se instala nada en macOS. La transición debe ejecutarse en este orden:

1. fixtures Protobuf y eventos equivalentes al runtime TS;
2. transporte libp2p Rust y handshake FHS real;
3. integración Atlas/Star/OCR/KB/RAG;
4. E2E completo y failover;
5. cambio del contenedor `fhs-navigator` a Rust;
6. retirada de la ruta TS productiva, conservándola solo como referencia.

El código base de la primera capa está en
[`galaxIA-agent`](https://github.com/rafex/galaxIA-agent). El IDL que consume
está versionado y se compara con `galaxIA/idl/fhs-protocol.proto`.
