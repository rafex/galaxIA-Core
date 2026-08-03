/**
 * Helpers GossipSub para nodos FHS.
 * Todos los mensajes se serializan como JSON (UTF-8).
 */

import { fromString, toString } from "uint8arrays";
import type { FhsNode } from "./create-node.js";

/** Suscribe a un topic de GossipSub y llama a `handler` con cada mensaje. */
export function subscribe<T = unknown>(
  node: FhsNode,
  topic: string,
  handler: (msg: T) => void,
): void {
   
  node.services.pubsub.addEventListener("message", (evt: any) => {
    if (evt.detail?.topic !== topic) return;
    try {
      const data = evt.detail.data instanceof Uint8Array
        ? evt.detail.data
        : fromString(toString(evt.detail.data, "utf8"), "utf8");
      handler(JSON.parse(toString(data, "utf8")) as T);
    } catch {
      // Mensaje mal formado — ignorar
    }
  });
  node.services.pubsub.subscribe(topic);
}

/** Publica un mensaje JSON en un topic de GossipSub. */
export async function publish(node: FhsNode, topic: string, payload: unknown): Promise<void> {
  const data = fromString(JSON.stringify(payload), "utf8");
  await node.services.pubsub.publish(topic, data);
}

/** Da de baja todos los listeners de un topic y deja de recibirlo. */
export function unsubscribe(node: FhsNode, topic: string): void {
  node.services.pubsub.unsubscribe(topic);
}
