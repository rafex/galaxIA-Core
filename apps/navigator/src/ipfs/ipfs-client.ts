/**
 * Cliente mínimo hacia un nodo IPFS compatible con la API de Kubo — usado
 * exclusivamente por Navigator (DEC-0051: Navigator es quien sube adjuntos
 * a IPFS, el Portal nunca guarda credenciales de escritura).
 *
 * `IPFS_API_URL` es el endpoint de escritura (config local, nunca viaja por
 * el protocolo — DEC-0046). Si no está configurado, IPFS simplemente no
 * está disponible y el transporte directo sigue funcionando sin cambios.
 */

const IPFS_API_URL = process.env.IPFS_API_URL;
const IPFS_PUBLIC_GATEWAY_URL = process.env.IPFS_PUBLIC_GATEWAY_URL || "https://ipfs.io/ipfs";
const IPFS_PRIVATE_GATEWAY_URL = process.env.IPFS_PRIVATE_GATEWAY_URL;

export function isIpfsConfigured(): boolean {
  return !!IPFS_API_URL;
}

export function getPublicGatewayUrl(): string {
  return IPFS_PUBLIC_GATEWAY_URL;
}

/**
 * Resuelve el `gatewayUrl` a incluir en un `ArtifactRef` según la red
 * elegida por el usuario (DEC-0045). Público usa el default configurado
 * (DEC-0052, pregunta #6); privado requiere `IPFS_PRIVATE_GATEWAY_URL`.
 */
export function resolveGatewayUrl(network: "public" | "private"): string {
  if (network === "private") {
    if (!IPFS_PRIVATE_GATEWAY_URL) {
      throw new Error("IPFS_PRIVATE_GATEWAY_URL no configurado — no se puede usar red privada");
    }
    return IPFS_PRIVATE_GATEWAY_URL;
  }
  return IPFS_PUBLIC_GATEWAY_URL;
}

export async function uploadToIpfs(base64: string, filename: string): Promise<string> {
  if (!IPFS_API_URL) throw new Error("IPFS_API_URL no configurado");

  const buffer = Buffer.from(base64, "base64");
  const form = new FormData();
  form.append("file", new Blob([buffer]), filename);

  const res = await fetch(`${IPFS_API_URL}/api/v0/add?pin=true`, { method: "POST", body: form });
  if (!res.ok) {
    throw new Error(`IPFS add falló: ${res.status} ${await res.text().catch(() => "")}`);
  }
  const data = (await res.json()) as { Hash: string };
  return data.Hash;
}

/**
 * Best-effort e idempotente — un CID ya despineado no debe romper el flujo
 * principal (se llama tanto tras un `tool.result` exitoso como en el TTL de
 * respaldo, DEC-0052; ambas rutas pueden coincidir en el mismo CID).
 */
export async function unpinFromIpfs(cid: string): Promise<void> {
  if (!IPFS_API_URL) return;
  try {
    await fetch(`${IPFS_API_URL}/api/v0/pin/rm?arg=${encodeURIComponent(cid)}`, { method: "POST" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ipfs] unpin falló para ${cid}: ${message}`);
  }
}

/** TTL de respaldo (DEC-0052) — solo cubre el caso en que nadie más borró el CID antes. */
export const IPFS_EPHEMERAL_BACKSTOP_MS = 3 * 60 * 60 * 1000;

export function scheduleBackstopUnpin(cid: string, retention: "ephemeral" | "reuse"): void {
  if (retention === "reuse") return;
  setTimeout(() => {
    void unpinFromIpfs(cid);
  }, IPFS_EPHEMERAL_BACKSTOP_MS).unref();
}
