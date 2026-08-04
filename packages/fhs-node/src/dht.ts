/**
 * Helpers DHT Kademlia para nodos FHS.
 * En @libp2p/kad-dht@16.x tanto put() como get() devuelven AsyncIterable<QueryEvent>.
 * Las claves deben tener un namespace registrado en kad-dht (ver create-node.ts).
 */

import { fromString } from "uint8arrays";
import type { FhsNode } from "./create-node.js";
import type { FhsWireCodec } from "./wire.js";

/** Publica un valor Protobuf en el DHT. Usa un AbortSignal de 5s. */
export async function dhtPut<T>(
  node: FhsNode,
  key: string,
  codec: FhsWireCodec<T>,
  value: T,
): Promise<void> {
  const keyBytes = fromString(key, "utf8");
  const valueBytes = codec.encode(value);
  const signal = AbortSignal.timeout(5_000);
  for await (const _ of node.services.dht.put(keyBytes, valueBytes, { signal })) {
    void _;
  }
}

/**
 * Lee un valor del DHT iterando los QueryEvents.
 * Devuelve el primer ValueEvent encontrado, o `null` si no hay ninguno.
 */
export async function dhtGet<T>(node: FhsNode, key: string, codec: FhsWireCodec<T>): Promise<T | null> {
  const keyBytes = fromString(key, "utf8");
  const signal = AbortSignal.timeout(5_000);
  try {
    for await (const event of node.services.dht.get(keyBytes, { signal })) {
      if (event.name === "VALUE" && event.value instanceof Uint8Array) {
        return codec.decode(event.value);
      }
    }
  } catch {
    return null;
  }
  return null;
}

/** Clave DHT para el BeaconRecord de un DID. Formato: `/fhs/beacon/<did>` */
export function dhtBeaconKey(did: string): string {
  return `/fhs/beacon/${did}`;
}

/** Clave DHT para el ReputationRecord de un DID. Formato: `/fhs/reputation/<did>` */
export function dhtReputationKey(did: string): string {
  return `/fhs/reputation/${did}`;
}
