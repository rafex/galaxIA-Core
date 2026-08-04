#!/usr/bin/env node
/**
 * Atlas FHS P2P — pure bootstrap peer.
 * Levanta un nodo libp2p (DHT server + GossipSub) para que otros nodos se
 * unan al swarm y exponé una REST API mínima para observabilidad/health.
 *
 * No tiene WebSocket registry ni handlers hello/register/ping (DEC-0088).
 */
import Fastify from "fastify";
import { readFileSync } from "node:fs";
import { FHS_VERSION } from "@rafex/galaxia-fhs-protocol";
import { startAtlasNode } from "./atlas/p2p-node.js";
import { announceAtlas } from "./atlas/mdns-announce.js";
import versionInfo from "./version.json" with { type: "json" };

const PORT = Number(process.env.PORT ?? 8081);
const HOST = process.env.HOST ?? "127.0.0.1";
const MDNS_ENABLED = process.env.MDNS_ENABLED !== "false";
const IDENTITY_KEY_PATH = process.env.IDENTITY_KEY_PATH ?? "./.fhs-identity-atlas.json";
const TLS_CERT_PATH = process.env.TLS_CERT_PATH;
const TLS_KEY_PATH = process.env.TLS_KEY_PATH;

// Multiaddrs en los que Atlas escucha conexiones libp2p.
// Default: TLS WebSocket en todas las interfaces, puerto 4001.
const FHS_LISTEN_ADDRS = process.env.FHS_LISTEN_ADDRS
  ? process.env.FHS_LISTEN_ADDRS.split(",").map((a) => a.trim())
  : ["/ip4/0.0.0.0/tcp/4001/tls/ws"];

async function main() {
  if (!TLS_CERT_PATH || !TLS_KEY_PATH) {
    throw new Error("Atlas requiere TLS_CERT_PATH y TLS_KEY_PATH; la API de observabilidad no admite HTTP");
  }
  const app = Fastify({
    logger: true,
    https: { cert: readFileSync(TLS_CERT_PATH), key: readFileSync(TLS_KEY_PATH) },
  });

  const { node, identity } = await startAtlasNode({
    identityKeyPath: IDENTITY_KEY_PATH,
    listenAddrs: FHS_LISTEN_ADDRS,
    tlsCertPath: TLS_CERT_PATH,
    tlsKeyPath: TLS_KEY_PATH,
  });

  app.log.info(`Atlas P2P iniciado. DID: ${identity.did}`);
  app.log.info(`Escuchando en: ${node.getMultiaddrs().map((a: { toString(): string }) => a.toString()).join(", ")}`);

  app.get("/health", () => ({
    ok: true,
    fhsVersion: FHS_VERSION,
    version: (versionInfo as { commit: string }).commit,
    buildDate: (versionInfo as { date: string }).date,
    did: identity.did,
    multiaddrs: node.getMultiaddrs().map((a: { toString(): string }) => a.toString()),
  }));

  app.get("/status", () => ({
    peers: node.getPeers().map((p: { toString(): string }) => p.toString()),
    peerCount: node.getPeers().length,
  }));

  try {
    await app.listen({ port: PORT, host: HOST });
    app.log.info(`API de observabilidad HTTPS en https://${HOST}:${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  if (MDNS_ENABLED) {
    const addrs = node.getMultiaddrs().map((a: { toString(): string }) => a.toString());
    announceAtlas(identity, addrs);
    app.log.info(`Anunciando Atlas por mDNS (did: ${identity.did})`);
  }

  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => {
      void node.stop().then(() => process.exit(0));
    });
  }
}

void main();
