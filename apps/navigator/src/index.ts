#!/usr/bin/env node
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { readFileSync } from "node:fs";
import { FHS_VERSION } from "@rafex/galaxia-fhs-protocol";
import { setupChatApi } from "./api/chat.js";
import { setupEventsApi } from "./api/events.js";
import { setupChatWebSocket } from "./api/chat-ws.js";
import { EventBus } from "./sse/event-bus.js";
import { connectNatsBridge } from "./nats-bridge.js";
import { isIpfsConfigured, getPublicGatewayUrl } from "./ipfs/ipfs-client.js";
import versionInfo from "./version.json" with { type: "json" };
import { initP2pProviders } from "./p2p/index.js";

const PORT = Number(process.env.PORT || 8090);
const HOST = process.env.HOST || "127.0.0.1";
const TLS_CERT_PATH = process.env.TLS_CERT_PATH;
const TLS_KEY_PATH = process.env.TLS_KEY_PATH;
const NATS_URL = process.env.NATS_URL;

const FHS_BOOTSTRAP_ADDRS = process.env.FHS_BOOTSTRAP_ADDRS
  ? process.env.FHS_BOOTSTRAP_ADDRS.split(",").map((a) => a.trim())
  : [];
const FHS_LISTEN_ADDRS = process.env.FHS_LISTEN_ADDRS
  ? process.env.FHS_LISTEN_ADDRS.split(",").map((a) => a.trim())
  : ["/ip4/0.0.0.0/tcp/4010/ws"];
const FHS_ANNOUNCE_ADDRS = process.env.FHS_ANNOUNCE_ADDRS
  ? process.env.FHS_ANNOUNCE_ADDRS.split(",").map((a) => a.trim())
  : undefined;
const IDENTITY_KEY_PATH = process.env.IDENTITY_KEY_PATH ?? "./.fhs-identity-navigator.json";

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
  const natsBridge = await connectNatsBridge(NATS_URL, eventBus, { warn: (msg) => app.log.warn(msg) });
  if (natsBridge.connected) app.log.info(`Puente NATS activo desde ${NATS_URL} (fhs.node.online / fhs.node.lost)`);

  // FHS solo tiene un camino de descubrimiento y ejecución: libp2p.
  app.log.info("[navigator-p2p] Modo libp2p activo");
  const p2pProviders = await initP2pProviders({
    identityKeyPath: IDENTITY_KEY_PATH,
    listenAddrs: FHS_LISTEN_ADDRS,
    announceAddrs: FHS_ANNOUNCE_ADDRS,
    bootstrapAddrs: FHS_BOOTSTRAP_ADDRS,
  });

  setupEventsApi(app, eventBus);
  setupChatApi(app, p2pProviders.atlasClient, eventBus, p2pProviders);
  setupChatWebSocket(app, p2pProviders.atlasClient, eventBus, p2pProviders);

  app.get("/health", () => ({
    ok: true,
    fhsVersion: FHS_VERSION,
    version: versionInfo.commit,
    buildDate: versionInfo.date,
  }));

  app.get("/api/ipfs-config", () => ({
    enabled: isIpfsConfigured(),
    publicGatewayUrl: getPublicGatewayUrl(),
  }));

  try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`Navigator running at ${tlsEnabled ? "https" : "http"}://${HOST}:${PORT} (FHS: libp2p)`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
