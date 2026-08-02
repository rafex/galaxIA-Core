import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { generateIdentity, loadIdentity, type NodeIdentity } from "@rafex/galaxia-fhs-protocol";

/**
 * Identidad Ed25519 del propio Registry (DEC-0032) — reutiliza el mismo
 * patrón que `examples/{llm,ocr}-provider/src/identity-store.ts` (DEC-0030).
 * Permite que un nodo que descubre el Registry por mDNS (SPEC-P2P-0001)
 * verifique que el anuncio viene firmado por la misma identidad persistida,
 * no de un impostor en la misma LAN transmitiendo un anuncio sin firmar.
 */
export function loadOrCreateIdentity(path: string): NodeIdentity {
  if (existsSync(path)) {
    return loadIdentity(readFileSync(path, "utf8"));
  }
  const identity = generateIdentity();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, identity.privateKeyPem, { mode: 0o600 });
  return identity;
}
