import type { FastifyInstance } from "fastify";
import { Atlas } from "../atlas/registry.js";

interface RecordSampleBody {
  providerId: string;
  capability: string;
  sample: {
    dispatchMs: number | null;
    totalMs: number;
    success: boolean;
    at: number;
  };
}

/**
 * Único endpoint de escritura que Navigator necesita contra Atlas — el
 * resto de /api/fhs/* (providers.ts) es solo lectura. Fire-and-forget desde
 * el lado de Navigator (ver AtlasClient): si Atlas está caído o lento, no
 * debe bloquear ni fallar el turno de chat, solo perder esa muestra de
 * telemetría (SPEC-SATRATING-0001).
 */
export function setupMetricsApi(app: FastifyInstance, registry: Atlas) {
  app.post("/api/fhs/metrics/sample", (req, reply) => {
    const body = req.body as RecordSampleBody;
    registry.recordSample(body.providerId, body.capability, body.sample);
    reply.status(204);
    return null;
  });
}
