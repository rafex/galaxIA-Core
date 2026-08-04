/**
 * Puente de eventos NATS→Navigator (SPEC-BRIDGE-0001, DEC-0074) — lado
 * consumidor del bridge de Atlas: se suscribe a `fhs.node.online`/
 * `fhs.node.lost` y reinyecta cada evento en el `EventBus` propio de
 * Navigator, el mismo canal que ya distribuye eventos de conversación al
 * Portal por `/api/chat/ws` — el Portal sigue viendo un solo canal de
 * eventos, sin una segunda conexión directa a Atlas.
 *
 * Opt-in explícito: sin `NATS_URL`, Navigator funciona exactamente igual
 * que hoy (el Portal no recibe notificaciones en vivo de altas/bajas de
 * nodos, pero el chat funciona igual — `AgentRuntime` resuelve el catálogo
 * en vivo por REST en cada turno, con o sin este bridge).
 */

import { connect, type NatsConnection, type Subscription } from "nats";
import type { AgentEvent } from "./agent/events.js";
import type { EventBus } from "./sse/event-bus.js";

const BRIDGED_SUBJECTS = ["fhs.node.online", "fhs.node.lost"];

export interface NatsBridgeConsumer {
  /** false si nunca se conectó (sin NATS_URL, o la conexión falló) — el caller lo usa para no loggear un "activo" engañoso. */
  connected: boolean;
  close(): Promise<void>;
}

const noopConsumer: NatsBridgeConsumer = {
  connected: false,
  async close() {
    /* nada que cerrar */
  },
};

export async function connectNatsBridge(
  natsUrl: string | undefined,
  eventBus: EventBus,
  log: { warn: (msg: string) => void }
): Promise<NatsBridgeConsumer> {
  if (!natsUrl) return noopConsumer;

  let nc: NatsConnection;
  try {
    nc = await connect({ servers: natsUrl });
  } catch (err) {
    log.warn(`No se pudo conectar a NATS (${natsUrl}) — Navigator sigue sin notificaciones en vivo de nodos: ${err instanceof Error ? err.message : String(err)}`);
    return noopConsumer;
  }

  const subs: Subscription[] = BRIDGED_SUBJECTS.map((subject) => {
    const sub = nc.subscribe(subject);
    void (async () => {
      for await (const msg of sub) {
        try {
          const event = JSON.parse(msg.string()) as AgentEvent;
          eventBus.emit(event);
        } catch {
          log.warn(`Mensaje NATS no parseable en ${subject}`);
        }
      }
    })();
    return sub;
  });

  return {
    connected: true,
    async close() {
      for (const sub of subs) sub.unsubscribe();
      await nc.drain();
    },
  };
}
