/** Helpers GossipSub para mensajes Protobuf binarios FHS. */

import type { FhsNode } from "./create-node.js";
import type { FhsWireCodec } from "./wire.js";

/** Suscribe a un topic de GossipSub y llama a `handler` con cada mensaje. */
export function subscribe<T>(
  node: FhsNode,
  topic: string,
  codec: FhsWireCodec<T>,
  handler: (msg: T) => void,
): void {
   
  node.services.pubsub.addEventListener("message", (evt: any) => {
    if (evt.detail?.topic !== topic) return;
    try {
      const data = evt.detail.data instanceof Uint8Array ? evt.detail.data : evt.detail.data.slice();
      handler(codec.decode(data));
    } catch {
      // Mensaje mal formado — ignorar
    }
  });
  node.services.pubsub.subscribe(topic);
}

/** Publica un mensaje Protobuf binario en un topic de GossipSub. */
export async function publish<T>(
  node: FhsNode,
  topic: string,
  codec: FhsWireCodec<T>,
  payload: T,
): Promise<void> {
  await node.services.pubsub.publish(topic, codec.encode(payload));
}

/** Da de baja todos los listeners de un topic y deja de recibirlo. */
export function unsubscribe(node: FhsNode, topic: string): void {
  node.services.pubsub.unsubscribe(topic);
}
