/**
 * Helpers de stream directo FHS con LPP framing.
 * Protocolo: /fhs/v1/0.1.0
 * Framing: it-length-prefixed (LPP) con payloads JSON.
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
import { fromString, toString } from "uint8arrays";
import { FHS_STREAM_PROTOCOL } from "./constants.js";
import type { FhsNode } from "./create-node.js";

export type StreamHandler<T = unknown> = (
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
  handler: StreamHandler<T>,
): void {
  node.handle(FHS_STREAM_PROTOCOL, async (stream: FhsNode) => {
    const decoded = lp.decode(stream) as unknown as AsyncIterable<Uint8ArrayList>;
    for await (const chunk of decoded) {
      const data = chunk instanceof Uint8Array ? chunk : chunk.slice();
      try {
        const msg = JSON.parse(toString(data, "utf8")) as T;
        await handler(msg, stream);
      } catch {
        // Mensaje mal formado
      }
      break; // handler toma el control después del primer mensaje
    }
  });
}

/**
 * Abre un stream directo al peer indicado y envía un mensaje JSON con LPP.
 * Devuelve el stream abierto para que el llamador pueda continuar leyendo.
 */
export async function openFhsStream(
  node: FhsNode,
  peerId: FhsNode,
  msg: unknown,
): Promise<FhsNode> {
  const stream: FhsNode = await node.dialProtocol(peerId, FHS_STREAM_PROTOCOL);
  sendOnStream(stream, msg);
  return stream;
}

/**
 * Envía un mensaje JSON con LPP en un stream ya abierto.
 * lp.encode([bytes]) es síncrono (Iterable → Generator).
 * En libp2p 3.x la escritura se hace con stream.send() por cada chunk.
 */
export function sendOnStream(stream: FhsNode, msg: unknown): void {
  const bytes = fromString(JSON.stringify(msg), "utf8");
  for (const chunk of lp.encode([bytes])) {
    stream.send(chunk);
  }
}

/**
 * Lee el próximo mensaje JSON con LPP de un stream.
 * Devuelve `null` si el stream se cerró sin mensajes.
 */
export async function readFromStream<T = unknown>(stream: FhsNode): Promise<T | null> {
  const decoded = lp.decode(stream) as unknown as AsyncIterable<Uint8ArrayList>;
  for await (const chunk of decoded) {
    const data = chunk instanceof Uint8Array ? chunk : chunk.slice();
    return JSON.parse(toString(data, "utf8")) as T;
  }
  return null;
}
