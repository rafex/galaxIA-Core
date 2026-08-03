/**
 * Nodo libp2p de Atlas en modo DHT server.
 * Atlas actúa como pure bootstrap peer: proporciona lista de peers al swarm
 * y almacena registros DHT para que otros nodos encuentren sus BeaconRecords.
 * No tiene WebSocket registry ni handlers hello/register/ping.
 */

import { createFhsNode, loadOrCreateFhsIdentity } from "@rafex/galaxia-fhs-node";

export interface AtlasP2pConfig {
  identityKeyPath: string;
  listenAddrs: string[];
}

export async function startAtlasNode(config: AtlasP2pConfig) {
  const identity = await loadOrCreateFhsIdentity(config.identityKeyPath);

  const node = await createFhsNode({
    identity,
    listenAddrs: config.listenAddrs,
    dhtMode: "server",
  });

  await node.start();
  return { node, identity };
}
