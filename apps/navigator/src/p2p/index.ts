/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
/**
 * Punto de entrada del módulo P2P del Navigator (DEC-0088).
 * Inicia el nodo libp2p, PeerCache, BidCollector y los providers P2P.
 */

import type { AtlasClient } from "../atlas-client.js";
import { create } from "@bufbuild/protobuf";
import { FhsProto } from "@rafex/galaxia-fhs-protocol";
import { LlmGateway } from "../providers/llm-gateway.js";
import { McpHost } from "../providers/mcp-host.js";
import {
  loadOrCreateFhsIdentity,
  createNavNode,
  PeerCache,
  BidCollector,
  pubsubSubscribe,
  pubsubPublish,
  dhtPut,
} from "./nav-node.js";
import { configureSigner, dhtBeaconCodec, makeNavigatorBeacon, missionBidCodec, nodeAdvertiseCodec } from "./p2p-wire.js";
import { P2pAtlasClient } from "./p2p-atlas-client.js";
import { P2pLlmGateway } from "./p2p-llm-gateway.js";
import { P2pMcpHost } from "./p2p-mcp-host.js";
import { registerPortalSession } from "./portal-session.js";
import {
  TOPIC_NODES_ADVERTISE,
  TOPIC_MISSIONS_BID,
} from "./fhs-p2p-types.js";

export interface P2pConfig {
  identityKeyPath: string;
  listenAddrs: string[];
  announceAddrs?: string[];
  bootstrapAddrs: string[];
  tlsCertPath?: string;
  tlsKeyPath?: string;
}

export interface P2pProviders {
  atlasClient: AtlasClient;
  llmGateway: LlmGateway;
  mcpHost: McpHost;
}

const ADVERTISE_INTERVAL_MS = 30_000;

export async function initP2pProviders(config: P2pConfig, eventBus?: import("../events/event-bus.js").EventBus): Promise<P2pProviders> {
  const identity = await loadOrCreateFhsIdentity(config.identityKeyPath);
  configureSigner(identity.did, identity.privateKey);
  console.log(`[navigator-p2p] DID: ${identity.did}`);

  const node = await createNavNode({
    identity,
    listenAddrs: config.listenAddrs,
    announceAddrs: config.announceAddrs,
    bootstrapAddrs: config.bootstrapAddrs,
    tlsCertPath: config.tlsCertPath,
    tlsKeyPath: config.tlsKeyPath,
  });

  const multiaddrs = (): string[] =>
    (node.getMultiaddrs() as Array<{ toString(): string }>).map((a) => a.toString());

  console.log(`[navigator-p2p] escuchando en: ${multiaddrs().join(", ")}`);

  // Esperar estabilización DHT
  await new Promise<void>((r) => setTimeout(r, 2_000));

  // Publicar beacon DHT
  const beaconPayload = create(FhsProto.DhtBeaconRecordSchema, {
    did: identity.did,
    beacon: makeNavigatorBeacon(),
    multiaddrs: multiaddrs(),
    publishedAt: BigInt(Date.now()),
    expiresAt: BigInt(Date.now() + 24 * 60 * 60 * 1_000),
    fhsVersion: "0.1",
    signature: new Uint8Array(0),
  });
  await dhtPut(node, `/fhs/beacon/${identity.did}`, beaconPayload, dhtBeaconCodec).catch(() => {});

  const peerCache = new PeerCache();
  const bidCollector = new BidCollector();

  // Suscribir a advertises → actualizar PeerCache
  pubsubSubscribe(node, TOPIC_NODES_ADVERTISE, (msg: FhsProto.NodeAdvertiseMessage) => {
    if (!msg.did) return;
    peerCache.upsert(msg);
  }, nodeAdvertiseCodec);

  // Suscribir a bids → alimentar BidCollector
  pubsubSubscribe(node, TOPIC_MISSIONS_BID, (bid: FhsProto.MissionBidMessage) => {
    if (!bid.missionId) return;
    bidCollector.addBid(bid);
  }, missionBidCodec);

  // Anuncio propio cada 30s
  const advertise = (): void => {
    const advertise = create(FhsProto.NodeAdvertiseMessageSchema, {
      did: identity.did,
      beacon: makeNavigatorBeacon(),
      multiaddrs: multiaddrs(),
      timestamp: BigInt(Date.now()),
      ttlSeconds: 60,
      trustLevel: "community",
      signature: new Uint8Array(0),
    });
    pubsubPublish(node, TOPIC_NODES_ADVERTISE, advertise, nodeAdvertiseCodec);
  };
  advertise();
  setInterval(advertise, ADVERTISE_INTERVAL_MS);

  const p2pAtlas = new P2pAtlasClient(peerCache);
  const p2pLlm = new P2pLlmGateway(node, identity, bidCollector);
  const p2pMcp = new P2pMcpHost(node, identity, bidCollector, peerCache);

  if (eventBus) registerPortalSession(node, identity, eventBus, {
    atlasClient: p2pAtlas,
    llmGateway: p2pLlm,
    mcpHost: p2pMcp,
  });

  return {
    atlasClient: p2pAtlas,
    llmGateway: p2pLlm,
    mcpHost: p2pMcp,
  };
}
