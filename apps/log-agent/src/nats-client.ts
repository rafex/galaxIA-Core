/**
 * Wrapper NATS opt-in para log-agent (DEC-0083) — mismo patrón que
 * apps/atlas/src/atlas/nats-bridge.ts (DEC-0074): sin `NATS_URL`, o si la
 * conexión falla, degrada a noop. Un NATS caído nunca debe tumbar el
 * agente ni impedir que siga escribiendo el archivo local — ese archivo es
 * la fuente de verdad para `lnav` en este host, NATS es solo un espejo.
 */

import { connect, type NatsConnection, type Subscription } from "nats";

export interface LogNatsClient {
  connected: boolean;
  publish(subject: string, line: string): void;
  subscribe(subject: string): AsyncIterable<{ subject: string; data: string }>;
  close(): Promise<void>;
}

const noopClient: LogNatsClient = {
  connected: false,
  publish() {
    /* no-op: NATS_URL no configurado o conexión fallida */
  },
  subscribe() {
    throw new Error("subscribe() requiere una conexión NATS activa (modo collect necesita NATS_URL válida)");
  },
  async close() {
    /* nada que cerrar */
  },
};

export async function createLogNatsClient(
  natsUrl: string | undefined,
  log: { warn: (msg: string) => void } = console
): Promise<LogNatsClient> {
  if (!natsUrl) return noopClient;

  let nc: NatsConnection;
  try {
    nc = await connect({ servers: natsUrl });
  } catch (err) {
    log.warn(`No se pudo conectar a NATS (${natsUrl}) — log-agent sigue escribiendo solo local: ${err instanceof Error ? err.message : String(err)}`);
    return noopClient;
  }

  return {
    connected: true,
    publish(subject: string, line: string) {
      nc.publish(subject, line);
    },
    async *subscribe(subject: string) {
      const sub: Subscription = nc.subscribe(subject);
      for await (const msg of sub) {
        yield { subject: msg.subject, data: new TextDecoder().decode(msg.data) };
      }
    },
    async close() {
      await nc.drain();
    },
  };
}
