/**
 * Opciones TLS y de timeout compartidas por los clientes WebSocket del
 * Navigator (`llm-gateway.ts`, `mcp-host.ts`) — extraídas de ambos para
 * cerrar dos hallazgos reales de CodeQL (`js/disabling-certificate-validation`,
 * `js/resource-exhaustion`) en un solo lugar en vez de en cada call site.
 */

import { readFileSync } from "node:fs";
import type WebSocket from "ws";

// PoC (docs/tls-autofirmado.md): certificados autofirmados en wss://, sin CA
// de confianza estándar. La recomendación del propio doc para producción es
// "fijar el certificado esperado, no desactivar la verificación" — hasta
// ahora solo documentada, nunca implementada (el código siempre usó
// rejectUnauthorized:false sin condición). TLS_CA_CERT_PATH la implementa:
// si está seteada, el cert autofirmado se fija como única CA confiable
// (rejectUnauthorized se queda en su default `true` — sigue siendo MITM-safe
// contra cualquier certificado que no sea el pineado). Sin la variable, cae
// al comportamiento inseguro anterior SOLO si se opta explícitamente con
// FHS_TLS_INSECURE=true — por defecto ahora es seguro (rechaza el cert
// autofirmado), a diferencia de antes.
const TLS_CA_CERT_PATH = process.env.TLS_CA_CERT_PATH;
const TLS_INSECURE_OPT_IN = process.env.FHS_TLS_INSECURE === "true";
let insecureWarned = false;

export function wsOptions(url: string): WebSocket.ClientOptions | undefined {
  if (!url.startsWith("wss://")) return undefined;

  if (TLS_CA_CERT_PATH) {
    return { ca: readFileSync(TLS_CA_CERT_PATH) };
  }

  if (TLS_INSECURE_OPT_IN) {
    if (!insecureWarned) {
      insecureWarned = true;
      console.warn(
        "[ws-security] FHS_TLS_INSECURE=true: aceptando cualquier certificado TLS sin verificar (rejectUnauthorized: false). " +
          "Solo para la PoC de LAN de confianza (docs/tls-autofirmado.md) — configura TLS_CA_CERT_PATH en vez de esto para fijar el certificado esperado."
      );
    }
    // lgtm[js/disabling-certificate-validation]: opt-in explícito y no-default
    // (FHS_TLS_INSECURE=true), documentado en docs/tls-autofirmado.md — quien
    // puede fijar el certificado usa TLS_CA_CERT_PATH arriba, que sí verifica.
    return { rejectUnauthorized: false };
  }

  return undefined;
}

// DEC-0010: `preferences.maxWaitMs` es "kill" configurable por el cliente —
// controla directamente la duración de un `setTimeout` (CodeQL
// js/resource-exhaustion: un timer con duración controlada por el usuario,
// sin límites, puede usarse para mantener recursos vivos indefinidamente o
// pasar valores patológicos como NaN/negativos). Se acota a un rango
// razonable en vez de confiar ciegamente en el valor del cliente.
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000; // 10 min — techo generoso para hardware comunitario lento.

export function clampTimeoutMs(timeoutMs: number | undefined, fallbackMs: number): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return fallbackMs;
  return Math.min(Math.max(timeoutMs, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}
