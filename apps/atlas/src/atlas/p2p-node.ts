/**
 * Nodo libp2p de Atlas en modo DHT server.
 * Atlas actúa como pure bootstrap peer: proporciona lista de peers al swarm
 * y almacena registros DHT para que otros nodos encuentren sus BeaconRecords.
 * No tiene WebSocket registry ni handlers hello/register/ping.
 *
 * GossipSub relay: Atlas suscribe a todos los topics del protocolo FHS para
 * que los mensajes entre Star y Navigator fluyan a través de él. Sin esta
 * suscripción, GossipSub enruta mensajes entre peers que no están
 * directamente conectados entre sí (solo el nodo suscrito recibe el mensaje).
 */

import { createFhsNode, loadOrCreateFhsIdentity } from "@rafex/galaxia-fhs-node";
import { readFileSync } from "node:fs";
import { webSockets } from "@libp2p/websockets";
import {
  TOPIC_NODES_ADVERTISE,
  TOPIC_MISSIONS_OFFER,
  TOPIC_MISSIONS_BID,
  TOPIC_MISSIONS_ASSIGN,
  TOPIC_REPUTATION_UPDATE,
} from "@rafex/galaxia-fhs-protocol";

export interface AtlasP2pConfig {
  identityKeyPath: string;
  listenAddrs: string[];
  tlsCertPath?: string;
  tlsKeyPath?: string;
}

const RELAY_TOPICS = [
  TOPIC_NODES_ADVERTISE,
  TOPIC_MISSIONS_OFFER,
  TOPIC_MISSIONS_BID,
  TOPIC_MISSIONS_ASSIGN,
  TOPIC_REPUTATION_UPDATE,
];

export async function startAtlasNode(config: AtlasP2pConfig) {
  const identity = await loadOrCreateFhsIdentity(config.identityKeyPath);
  const tlsRequired = config.listenAddrs.some((address) => address.includes("/tls/ws"));
  if (tlsRequired && (!config.tlsCertPath || !config.tlsKeyPath)) {
    throw new Error("Atlas requiere TLS_CERT_PATH y TLS_KEY_PATH para escuchar en /tls/ws");
  }
  const transport = config.tlsCertPath && config.tlsKeyPath
    ? webSockets({
        https: {
          cert: readFileSync(config.tlsCertPath),
          key: readFileSync(config.tlsKeyPath),
        },
      })
    : webSockets();

  const node = await createFhsNode({
    identity,
    listenAddrs: config.listenAddrs,
    dhtMode: "server",
    transport,
  });

  await node.start();

  for (const topic of RELAY_TOPICS) {
    node.services.pubsub.subscribe(topic);
  }

  return { node, identity };
}
