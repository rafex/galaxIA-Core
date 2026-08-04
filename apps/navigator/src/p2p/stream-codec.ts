/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call */
/**
 * Codificador/decodificador de envelopes FHS sobre framing LPP.
 * El payload completo es el Envelope protobuf generado por el SDK.
 */

import * as lp from "it-length-prefixed";
import { decodeEnvelope, encodeEnvelopeFrame } from "@rafex/galaxia-fhs-protocol";
import type { FhsProto } from "@rafex/galaxia-fhs-protocol";
import type { FhsNode } from "./nav-node.js";
import { sealEnvelope, verifyEnvelope } from "./p2p-wire.js";

export type FhsEnvelope = FhsProto.Envelope;

export function sendEnvelope(stream: FhsNode, envelope: FhsEnvelope): void {
  // encodeEnvelopeFrame ya aplica el mismo LPP que consume lp.decode.
  stream.send(encodeEnvelopeFrame(sealEnvelope(envelope)));
}

export async function* decodeStream(stream: FhsNode): AsyncGenerator<FhsEnvelope> {
  // Doble cast necesario: TypeScript resuelve lp.decode(any) al overload síncrono
  const decoded = lp.decode(stream) as unknown as AsyncIterable<{ slice(): Uint8Array }>;
  for await (const chunk of decoded) {
    const data = chunk.slice();
    try {
      const envelope = decodeEnvelope(data);
      if (!verifyEnvelope(envelope)) continue;
      yield envelope;
    } catch {
      // ignorar frames malformados
    }
  }
}
