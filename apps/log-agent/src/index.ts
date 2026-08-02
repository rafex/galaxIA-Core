/**
 * log-agent (DEC-0083) — capa operativa, no forma parte del protocolo FHS.
 * Corre una vez, junto al servidor NATS, agregando los logs que publican
 * los scripts `helpers/scripts/shell/log-agent-ship.sh` de cada host. Ver
 * docs/observabilidad-logs.md.
 */

import { runCollect } from "./collect.js";

const natsUrl = process.env.NATS_URL;
if (!natsUrl) {
  console.error("[log-agent] NATS_URL es requerida");
  process.exit(1);
}

runCollect({
  natsUrl,
  localDir: process.env.LOG_AGENT_LOCAL_DIR || "./logs",
}).catch((err) => {
  console.error(`[log-agent] error fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
