/**
 * Puente de eventos Atlas→NATS (SPEC-BRIDGE-0001, DEC-0074) — publica
 * `node.online`/`node.lost` (los únicos que Atlas emite hoy vía
 * `broadcastToRuntimes`, ver `registry.ts`) a subjects NATS para que crucen
 * al proceso de Navigator, que hoy los recibe atrapados en el `EventBus`
 * interno de Atlas sin ningún consumidor real (hallazgo de DEC-0035/#18).
 *
 * Opt-in explícito (mismo patrón que mDNS/TLS, DEC-0032): sin `NATS_URL`,
 * Atlas funciona exactamente igual que hoy. NATS core (pub/sub simple, sin
 * JetStream) — la spec dejó esa elección abierta; core basta porque esto es
 * una mejora de experiencia (notificaciones en vivo en el Portal), nunca una
 * dependencia funcional del pipeline de chat (`AgentRuntime` resuelve el
 * catálogo en vivo por REST en cada turno, con o sin NATS).
 */

import { connect, type NatsConnection } from "nats";
import type { AgentSSEEvent } from "@rafex/galaxia-fhs-protocol";

const BRIDGED_EVENT_TYPES = new Set(["node.online", "node.lost"]);

function subjectFor(eventType: string): string {
  return `fhs.${eventType}`;
}

export interface NatsBridge {
  /** false si nunca se conectó (sin NATS_URL, o la conexión falló) — el caller lo usa para no loggear un "activo" engañoso. */
  connected: boolean;
  publish(event: AgentSSEEvent): void;
  close(): Promise<void>;
}

const noopBridge: NatsBridge = {
  connected: false,
  publish() {
    /* no-op: NATS_URL no configurado o conexión fallida */
  },
  async close() {
    /* nada que cerrar */
  },
};

/**
 * Conecta a NATS si `natsUrl` viene definido; si la conexión falla, degrada
 * a no-op con un warning — un NATS caído nunca debe tumbar a Atlas (misma
 * filosofía que mDNS opt-in: una mejora de conveniencia, no una dependencia
 * dura).
 */
export async function createNatsBridge(natsUrl: string | undefined, log: { warn: (msg: string) => void }): Promise<NatsBridge> {
  if (!natsUrl) return noopBridge;

  let nc: NatsConnection;
  try {
    nc = await connect({ servers: natsUrl });
  } catch (err) {
    log.warn(`No se pudo conectar a NATS (${natsUrl}) — Atlas sigue sin el bridge: ${err instanceof Error ? err.message : String(err)}`);
    return noopBridge;
  }

  return {
    connected: true,
    publish(event: AgentSSEEvent) {
      if (!BRIDGED_EVENT_TYPES.has(event.type)) return;
      nc.publish(subjectFor(event.type), JSON.stringify(event));
    },
    async close() {
      await nc.drain();
    },
  };
}
