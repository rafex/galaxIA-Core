import type { FastifyInstance, FastifyRequest } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import {
  type FhsMessage,
  type NodeIdentity,
  HEARTBEAT_INTERVAL_SECONDS,
  FHS_ERROR_CODES,
  FHS_VERSION,
  MAX_REPLAY_AGE_MS,
  MAX_CLOCK_SKEW_MS,
  verifySignature,
  signPayload,
  helloSignaturePayload,
  registerSignaturePayload,
  welcomeSignaturePayload,
} from "@rafex/galaxia-fhs-protocol";
import { Atlas } from "./registry.js";
import { validateManifest } from "./manifest-validation.js";

// Todo timestamp del protocolo va en MILISEGUNDOS (Date.now()) — antes esta
// validación operaba en segundos mientras todos los providers reales enviaban
// ms, y ningún registro pasaba (revisión del protocolo, 2026-07-10). Las
// ventanas viven ahora en el propio protocolo (constants.ts).
function validateTimestamp(ts: number): true | string {
  const age = Date.now() - ts;
  if (age > MAX_REPLAY_AGE_MS) {
    return `Timestamp demasiado antiguo (${age}ms > ${MAX_REPLAY_AGE_MS}ms) — posible reenvío. Recuerda: timestamp en milisegundos (Date.now())`;
  }
  if (age < -MAX_CLOCK_SKEW_MS) {
    return `Timestamp en el futuro (${-age}ms > ${MAX_CLOCK_SKEW_MS}ms) — reloj desincronizado. Recuerda: timestamp en milisegundos (Date.now())`;
  }
  return true;
}

// Compatibilidad de versión (negociación en hello, revisión 2026-07-10): en
// 0.x cualquier cambio de minor puede romper — solo se acepta la versión
// exacta. Ausente = nodo pre-negociación, se asume compatible.
function isVersionCompatible(v: string | undefined): boolean {
  return v === undefined || v === FHS_VERSION;
}

export function setupWebSocket(app: FastifyInstance, registry: Atlas, identity: NodeIdentity) {
  app.get("/fhs/v1/ws", { websocket: true }, (socket: WebSocket, _req: FastifyRequest) => {
    let providerId: string | null = null;
    let pingTimer: NodeJS.Timeout | null = null;

    const send = (msg: FhsMessage) => {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify(msg));
      }
    };

    // Pulse de transporte (DEC-0010): ping/pong nativo de WebSocket (RFC 6455),
    // no un mensaje FHS — el Registry sondea a cada nodo conectado para detectar
    // conexiones rotas (proceso caído, red partida) más rápido que el lease de
    // aplicación (LEASE_EXPIRE_SECONDS). Complementa, no reemplaza, el heartbeat
    // de aplicación (`ping`/`pong` JSON) ni dispatch.ack — no dice nada de si el
    // nodo está "atorado" procesando una Mission, solo si el socket responde.
    //
    // Tolera MISSED_PONG_THRESHOLD ciclos sin `pong` (no 1) antes de terminar
    // la conexión — con 1 ciclo, esta señal quedaba más estricta que el propio
    // lease de aplicación (30s) que complementa, pudiendo desconectar a un nodo
    // legítimamente ocupado en un cómputo bloqueante breve. Aun con esto,
    // sigue sin distinguir "atorado" de "ocupado pero progresando" — esa
    // garantía depende del dispatcher concurrente ("mosquito") que cada nodo
    // debe implementar (DEC-0009/satelite-rating): asegura que en algún
    // momento se responderá, no cuándo.
    const MISSED_PONG_THRESHOLD = 3;
    let missedPongs = 0;
    socket.on("pong", () => {
      missedPongs = 0;
    });
    pingTimer = setInterval(() => {
      if (missedPongs >= MISSED_PONG_THRESHOLD) {
        socket.terminate();
        return;
      }
      missedPongs += 1;
      socket.ping();
    }, HEARTBEAT_INTERVAL_SECONDS * 1000);

    socket.on("message", (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as FhsMessage;
        handleMessage(msg);
      } catch (_err) {
        send({ type: "error", data: { code: FHS_ERROR_CODES.PARSE_ERROR, message: "Invalid JSON" } });
      }
    });

    socket.on("close", () => {
      if (providerId) {
        registry.removeConnection(providerId);
      }
      if (pingTimer) clearInterval(pingTimer);
    });

    function handleMessage(msg: FhsMessage) {
      switch (msg.type) {
        case "hello": {
          const hello = msg;
          // DEC-0030: providerId es un did:key real (Ed25519) — la firma se
          // verifica contra la clave pública derivada del propio identificador,
          // sin directorio de claves aparte. Suplantar a otro nodo deja de ser
          // posible con solo conectarse y reutilizar su providerId (DEC-0009
          // ya lo mitigaba parcialmente a nivel de conexión activa; esto lo
          // hace criptográficamente imposible sin la clave privada real).
          if (!isVersionCompatible(hello.fhsVersion)) {
            send({
              type: "error",
              data: {
                code: FHS_ERROR_CODES.UNSUPPORTED_VERSION,
                message: `Este Registry habla FHS ${FHS_VERSION}; el nodo anunció ${hello.fhsVersion ?? "?"}`,
              },
            });
            socket.close(4010, "unsupported-version");
            return;
          }
          const helloPayload = helloSignaturePayload(hello.providerId, hello.timestamp);
          if (!hello.signature || !verifySignature(hello.providerId, helloPayload, hello.signature)) {
            send({
              type: "error",
              data: {
                code: FHS_ERROR_CODES.INVALID_SIGNATURE,
                message: "Firma Ed25519 inválida o ausente para este providerId",
              },
            });
            return;
          }
          const replayCheck = validateTimestamp(hello.timestamp);
          if (replayCheck !== true) {
            send({
              type: "error",
              data: {
                code: FHS_ERROR_CODES.INVALID_SIGNATURE,
                message: replayCheck,
              },
            });
            return;
          }
          if (registry.hasActiveConnection(hello.providerId)) {
            // DEC-0009: no sobrescribir una conexión activa en silencio.
            send({
              type: "error",
              data: {
                code: FHS_ERROR_CODES.ALREADY_REGISTERED,
                message: `providerId ${hello.providerId} ya tiene una conexión activa`,
              },
            });
            socket.close(4009, "already-registered");
            return;
          }
          providerId = hello.providerId;
          registry.registerConnection(providerId, socket);
          // welcome firmado (revisión 2026-07-10): el Atlas se autentica con
          // su propia identidad did:key — un nodo puede verificar que no está
          // entregando su manifiesto a un Registry impostor en la misma LAN.
          const welcomeTs = Date.now();
          send({
            type: "welcome",
            registryId: identity.did,
            leaseSeconds: registry.leaseSeconds,
            heartbeatSeconds: HEARTBEAT_INTERVAL_SECONDS,
            fhsVersion: FHS_VERSION,
            timestamp: welcomeTs,
            signature: signPayload(identity.privateKey, welcomeSignaturePayload(identity.did, welcomeTs)),
          });
          break;
        }
        case "register": {
          const register = msg;
          if (!providerId) {
            send({ type: "error", data: { code: FHS_ERROR_CODES.NOT_IDENTIFIED, message: "Send hello first" } });
            return;
          }
          // DEC-0030: register también viaja firmado — el hello ya probó la
          // identidad, pero register lleva su propio timestamp y podría
          // reenviarse/alterarse por separado. Desde la revisión 2026-07-10
          // la firma ancla además el hash canónico del manifiesto — sin él,
          // un MITM podía sustituir el manifiesto (endpoint incluido)
          // conservando una firma válida. El payload legado sin hash (que
          // aceptaba esta verificación como fallback deprecado) se retiró
          // en DEC-0076: en alpha (0.1.x) sin consumidores externos reales,
          // no valía la pena mantener abierta la vulnerabilidad que esta
          // firma existe para cerrar.
          const registerPayload = registerSignaturePayload(providerId, register.timestamp, register.manifest);
          const signatureOk = !!register.signature && verifySignature(providerId, registerPayload, register.signature);
          if (!signatureOk) {
            send({
              type: "error",
              data: {
                code: FHS_ERROR_CODES.INVALID_SIGNATURE,
                message: "Firma Ed25519 inválida o ausente en register",
              },
            });
            return;
          }
          const replayCheck = validateTimestamp(register.timestamp);
          if (replayCheck !== true) {
            send({
              type: "error",
              data: {
                code: FHS_ERROR_CODES.INVALID_SIGNATURE,
                message: replayCheck,
              },
            });
            return;
          }
          // DEC-0013: rechazar manifiestos incompletos, no aceptarlos con
          // valores por defecto silenciosos (ver docs/protocolo-provider.md,
          // "Manifiesto — campos obligatorios sin excepción").
          const validation = validateManifest(register.manifest);
          if (!validation.valid) {
            send({
              type: "error",
              data: {
                code: FHS_ERROR_CODES.INVALID_MANIFEST,
                message: `Manifiesto incompleto, faltan campos obligatorios: ${validation.missing.join(", ")}`,
              },
            });
            return;
          }
          const accepted = registry.registerOrUpdate(providerId, register.manifest);
          send({
            type: "registered",
            // ms, como todo timestamp del protocolo (revisión 2026-07-10).
            leaseExpires: Date.now() + registry.leaseSeconds * 1000,
            acceptedServices: accepted,
          });
          break;
        }
        case "ping": {
          if (providerId) registry.touchConnection(providerId);
          send({ type: "pong", timestamp: Date.now() });
          break;
        }
      }
    }
  });
}
