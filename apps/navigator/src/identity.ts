import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { generateIdentity, loadIdentity, type NodeIdentity } from "@rafex/galaxia-fhs-protocol";

/**
 * Identidad Ed25519 del propio Navigator (revisión del protocolo 2026-07-10)
 * — mismo patrón que el identity-store del Atlas (DEC-0032). El Navigator la
 * usa como `callerId` para firmar sus invocaciones (`chat.request`,
 * `tool.call`, `tool.list`): sin esto, un provider no puede distinguir a su
 * Agent Server de cualquier otro peer de la LAN que quiera consumir su
 * cómputo gratis.
 */

const IDENTITY_KEY_PATH = process.env.NAVIGATOR_IDENTITY_KEY_PATH || "./.fhs-identity-navigator.pem";

let cached: NodeIdentity | null = null;

export function getNavigatorIdentity(): NodeIdentity {
  if (cached) return cached;
  if (existsSync(IDENTITY_KEY_PATH)) {
    cached = loadIdentity(readFileSync(IDENTITY_KEY_PATH, "utf8"));
    return cached;
  }
  const identity = generateIdentity();
  mkdirSync(dirname(IDENTITY_KEY_PATH), { recursive: true });
  writeFileSync(IDENTITY_KEY_PATH, identity.privateKeyPem, { mode: 0o600 });
  cached = identity;
  return cached;
}
