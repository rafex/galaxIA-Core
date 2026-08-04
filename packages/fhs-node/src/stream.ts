/**
 * Helpers de stream directo FHS con LPP framing.
 * Protocolo: /fhs/v1/0.1.0
 * Framing: it-length-prefixed (LPP) con payloads Protobuf binarios.
 *
 * En libp2p 3.x los streams son AsyncIterable (lectura) + stream.send() (escritura).
 * NO tienen source/sink como en v1/v2.
 *
 * lp.decode devuelve Generator (sync) o AsyncGenerator (async) según el source.
 * Cuando el source es `any`, TypeScript resuelve al overload síncrono; el cast doble
 * (via `unknown`) fuerza AsyncIterable que es lo que devuelve libp2p 3.x en runtime.
 */

import * as lp from "it-length-prefixed";
import { Uint8ArrayList } from "uint8arraylist";
import { FHS_STREAM_PROTOCOL } from "./constants.js";
import type { FhsNode } from "./create-node.js";
import type { FhsWireCodec } from "./wire.js";

export type StreamHandler<T> = (
  msg: T,
  stream: FhsNode,
) => void | Promise<void>;

/**
 * Registra un handler para el protocolo /fhs/v1/0.1.0.
 * El handler recibe el primer mensaje decodificado y el stream completo
 * para responder o leer más mensajes.
 */
export function handleFhsStream<T = unknown>(
  node: FhsNode,
  codec: FhsWireCodec<T>,
  handler: StreamHandler<T>,
): void {
  node.handle(FHS_STREAM_PROTOCOL, async (stream: FhsNode) => {
    const decoded = lp.decode(stream) as unknown as AsyncIterable<Uint8ArrayList>;
    for await (const chunk of decoded) {
      const data = chunk instanceof Uint8Array ? chunk : chunk.slice();
      try {
        const msg = codec.decode(data);
        await handler(msg, stream);
      } catch {
        // Mensaje mal formado
      }
      break; // handler toma el control después del primer mensaje
    }
  });
}

/**
 * Abre un stream directo al peer indicado y envía un mensaje Protobuf con LPP.
 * Devuelve el stream abierto para que el llamador pueda continuar leyendo.
 */
export async function openFhsStream<T>(
  node: FhsNode,
  peerId: FhsNode,
  codec: FhsWireCodec<T>,
  msg: T,
): Promise<FhsNode> {
  const stream: FhsNode = await node.dialProtocol(peerId, FHS_STREAM_PROTOCOL);
  sendOnStream(stream, codec, msg);
  return stream;
}

/**
 * Envía un mensaje Protobuf con LPP en un stream ya abierto.
 * lp.encode([bytes]) es síncrono (Iterable → Generator).
 * En libp2p 3.x la escritura se hace con stream.send() por cada chunk.
 */
export function sendOnStream<T>(stream: FhsNode, codec: FhsWireCodec<T>, msg: T): void {
  const bytes = codec.encode(msg);
  for (const chunk of lp.encode([bytes])) {
    stream.send(chunk);
  }
}

/**
 * Lee el próximo mensaje Protobuf con LPP de un stream.
 * Devuelve `null` si el stream se cerró sin mensajes.
 */
export async function readFromStream<T>(stream: FhsNode, codec: FhsWireCodec<T>): Promise<T | null> {
  const decoded = lp.decode(stream) as unknown as AsyncIterable<Uint8ArrayList>;
  for await (const chunk of decoded) {
    const data = chunk instanceof Uint8Array ? chunk : chunk.slice();
    return codec.decode(data);
  }
  return null;
}
