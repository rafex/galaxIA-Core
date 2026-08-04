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

  const node = await createFhsNode({
    identity,
    listenAddrs: config.listenAddrs,
    dhtMode: "server",
  });

  await node.start();

  for (const topic of RELAY_TOPICS) {
    node.services.pubsub.subscribe(topic);
  }

  return { node, identity };
}
