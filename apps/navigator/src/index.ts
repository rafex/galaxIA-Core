#!/usr/bin/env node
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { readFileSync } from "node:fs";
import { FHS_VERSION } from "@rafex/galaxia-fhs-protocol";
import { AtlasClient } from "./atlas-client.js";
import { setupChatApi } from "./api/chat.js";
import { setupEventsApi } from "./api/events.js";
import { setupChatWebSocket } from "./api/chat-ws.js";
import { EventBus } from "./sse/event-bus.js";
import { connectNatsBridge } from "./nats-bridge.js";
import { isIpfsConfigured, getPublicGatewayUrl } from "./ipfs/ipfs-client.js";
import versionInfo from "./version.json" with { type: "json" };

const PORT = Number(process.env.PORT || 8090);
const HOST = process.env.HOST || "127.0.0.1";
// DEC-0035: Navigator ya no hospeda a Atlas — le habla por HTTP. Sin
// descubrimiento mDNS todavía (deferido, ver DEC-0035): se requiere la URL
// explícita, mismo patrón que REGISTRY_URL en los providers de ejemplo antes
// de DEC-0032.
const ATLAS_URL = process.env.ATLAS_URL || "http://localhost:8081";
// TLS opt-in: si TLS_CERT_PATH/TLS_KEY_PATH están seteados, la Chat API sirve
// wss:// en vez de ws:// (ver docs/tls-autofirmado.md). Certificado
// autofirmado, solo para la PoC.
const TLS_CERT_PATH = process.env.TLS_CERT_PATH;
const TLS_KEY_PATH = process.env.TLS_KEY_PATH;
// Puente de eventos desde Atlas vía NATS (SPEC-BRIDGE-0001, DEC-0074) —
// opt-in, mismo NATS_URL que Atlas debe apuntar al mismo servidor. Sin él,
// Navigator funciona igual que hoy (el chat no depende de esto, ver
// nats-bridge.ts).
const NATS_URL = process.env.NATS_URL;

async function main() {
  const tlsEnabled = !!(TLS_CERT_PATH && TLS_KEY_PATH);

  const app = (
    tlsEnabled
      ? Fastify({
          logger: true,
          https: { cert: readFileSync(TLS_CERT_PATH), key: readFileSync(TLS_KEY_PATH) },
        })
      : Fastify({ logger: true })
  ) as FastifyInstance;

  await app.register(websocket);

  const eventBus = new EventBus();
  const atlasClient = new AtlasClient(ATLAS_URL);

  const natsBridge = await connectNatsBridge(NATS_URL, eventBus, { warn: (msg) => app.log.warn(msg) });
  if (natsBridge.connected) app.log.info(`Puente NATS activo desde ${NATS_URL} (fhs.node.online / fhs.node.lost)`);

  setupEventsApi(app, eventBus);
  setupChatApi(app, atlasClient, eventBus);
  setupChatWebSocket(app, atlasClient, eventBus);

  app.get("/health", () => ({
    ok: true,
    fhsVersion: FHS_VERSION,
    version: versionInfo.commit,
    buildDate: versionInfo.date,
  }));

  // SPEC-IPFS-0001 (DEC-0052): el Portal necesita saber si IPFS está
  // disponible y cuál es el gateway público default para mostrárselo al
  // usuario antes de que elija ese transporte — no un dato oculto.
  app.get("/api/ipfs-config", () => ({
    enabled: isIpfsConfigured(),
    publicGatewayUrl: getPublicGatewayUrl(),
  }));

  try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`Navigator running at ${tlsEnabled ? "https" : "http"}://${HOST}:${PORT} (Atlas: ${ATLAS_URL})`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
