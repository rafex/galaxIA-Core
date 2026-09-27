/**
 * Factory que levanta un nodo libp2p con el stack canónico FHS:
 *   WSS transport + Noise + yamux + Kademlia DHT + GossipSub + Identify.
 * En tests, pasar un transport de memoria en lugar de webSockets.
 *
 * DHT: registra validators/selectors FHS para namespace "/fhs/*".
 * KadDHT solo acepta claves de namespaces registrados ("/pk/" e "/ipns/" por
 * defecto); sin registrar "fhs", el store/get falla silenciosamente.
 */

import { createLibp2p } from "libp2p";
import { webSockets } from "@libp2p/websockets";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { kadDHT, passthroughMapper } from "@libp2p/kad-dht";
import { gossipsub } from "@libp2p/gossipsub";
import { identify } from "@libp2p/identify";
import { ping } from "@libp2p/ping";
import { attachNodeDiagnostics, consoleDiagLogger, dialBootstraps, type DiagLogger } from "./diagnostics.js";
import type { FhsIdentity } from "./identity.js";

export interface FhsNodeConfig {
  identity: FhsIdentity;
  /** Direcciones de escucha. Default: ['/ip4/0.0.0.0/tcp/0/ws'] */
  listenAddrs?: string[];
  /**
   * Direcciones que el nodo anuncia a sus peers (override de las detectadas).
   * Útil en entornos containerizados donde la IP local no es alcanzable
   * desde otros containers (ej. pasta networking: anunciar 169.254.1.2 en lugar
   * de 192.168.1.139 para que otros containers puedan hacer dial).
   */
  announceAddrs?: string[];
  /**
   * Multiaddrs de los bootstrap peers (ej. Atlas).
   * Al arrancar el nodo los conectará automáticamente para unirse al swarm.
   */
  bootstrapAddrs?: string[];
  /**
   * Modo DHT: 'server' para Atlas (responde queries), 'client' para los demás.
   * Mapea a `clientMode: false` (server) y `clientMode: true` (client) de kad-dht v16.
   */
  dhtMode?: "server" | "client";
  /**
   * Transport factory a usar. Default: webSockets().
   * Pasar memory() para tests.
   */

  transport?: any;
  /**
   * Dónde registrar bootstrap y conexiones. Default: consola con el prefijo
   * `[fhs-node]`. Atlas pasa su propio label.
   */
  logger?: DiagLogger;
  /** Registrar cada conexión abierta/cerrada. Default: true. */
  logConnections?: boolean;
}

 
export type FhsNode = any;

/**
 * Crea y devuelve un nodo libp2p con el stack canónico FHS.
 * El nodo devuelto NO está iniciado — llamar a node.start() cuando esté listo.
 */
export async function createFhsNode(config: FhsNodeConfig): Promise<FhsNode> {
  const {
    identity,
    listenAddrs = ["/ip4/0.0.0.0/tcp/0/ws"],
    announceAddrs,
    bootstrapAddrs = [],
    dhtMode = "client",
    transport,
  } = config;

  const addresses: { listen: string[]; announce?: string[] } = { listen: listenAddrs };
  if (announceAddrs && announceAddrs.length > 0) {
    addresses.announce = announceAddrs;
  }

  const node = await createLibp2p({
    privateKey: identity.privateKey,
    addresses,
    transports: [transport ?? webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      ping: ping(),
      dht: kadDHT({
        clientMode: dhtMode === "client",
        // Sin esto kad-dht descarta las direcciones privadas de la LAN y la
        // tabla de rutas queda vacía (E2E-032).
        peerInfoMapper: passthroughMapper,
        // Registrar el namespace FHS para que KadDHT acepte claves /fhs/*
        // ValidateFn: (key, value) => void (lanza si inválido)
        // SelectFn: (key, records) => number (índice del mejor record)
        validators: { fhs: (_k: Uint8Array, _v: Uint8Array) => {} },
        selectors: { fhs: (_k: Uint8Array, _rs: Uint8Array[]) => 0 },
      }),
      pubsub: gossipsub(),
    },
  });

  const logger = config.logger ?? consoleDiagLogger("fhs-node");
  if (config.logConnections !== false) attachNodeDiagnostics(node, logger);

  if (bootstrapAddrs.length > 0) {
    // Reintenta con backoff hasta conectar y registra cada fallo: antes era un
    // solo intento silencioso y el nodo quedaba aislado si Atlas no estaba
    // escuchando aún (arranque simultáneo tras reiniciar el host).
    node.addEventListener("start", () => {
      dialBootstraps(node, bootstrapAddrs, logger);
    });
  }

  return node;
}
