/**
 * Modo "collect" (DEC-0083) — corre una vez, junto al servidor NATS.
 * Se suscribe a `logs.>` (todos los hosts/contenedores que estén
 * publicando) y arma un único archivo agregado `all.log`, formato
 * `[host/container] línea` — el archivo que se abre con
 * `lnav -f logs/all.log` para ver todo el sistema en una sola línea de
 * tiempo, sin saltar de SSH en SSH.
 *
 * A diferencia de "ship", este modo SÍ requiere NATS_URL — sin conexión no
 * hay nada que agregar, así que falla explícito en vez de quedarse inerte.
 */

import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { createLogNatsClient } from "./nats-client.js";

export interface CollectConfig {
  natsUrl: string;
  localDir: string;
}

/** `logs.<host>.<container>` → `{host, container}` — el subject ya trae la metadata, no hace falta duplicarla en el payload. */
function parseSubject(subject: string): { host: string; container: string } {
  const parts = subject.split(".");
  return { host: parts[1] ?? "?", container: parts.slice(2).join(".") || "?" };
}

export async function runCollect(config: CollectConfig): Promise<void> {
  await mkdir(config.localDir, { recursive: true });
  const filePath = join(config.localDir, "all.log");

  const nats = await createLogNatsClient(config.natsUrl);
  if (!nats.connected) {
    throw new Error(`modo collect requiere una conexión NATS activa a ${config.natsUrl} — sin eso no hay nada que agregar`);
  }

  console.log(`[log-agent] modo collect — escribiendo ${filePath}, suscrito a logs.>`);

  for await (const msg of nats.subscribe("logs.>")) {
    const { host, container } = parseSubject(msg.subject);
    await appendFile(filePath, `[${host}/${container}] ${msg.data}\n`);
  }
}
