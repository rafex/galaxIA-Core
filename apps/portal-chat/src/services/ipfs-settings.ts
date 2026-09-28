/**
 * Adjuntos por IPFS (DEC-0095). La opción solo existe si el build trae
 * `VITE_FHS_IPFS_GATEWAY_URL`; sin ella el Portal usa siempre transmisión
 * directa. En la demo la red es la pública: el aviso de privacidad es
 * obligatorio y la red privada queda deshabilitada hasta su fase.
 */
import type { ApiOptions } from "./api.js";

export const IPFS_PRIVACY_WARNING =
  "Los archivos enviados por IPFS público pueden ser descargados por cualquiera que conozca su identificador. Usa solo documentos no sensibles.";

export type IpfsChoice = {
  ipfsEnabled: boolean;
  ipfsNetwork: "public" | "private";
  ipfsRetention: "ephemeral" | "reuse";
};

/** Gateway de lectura configurado en el build, o `null` si IPFS no está disponible. */
export function ipfsGateway(raw: string | undefined): string | null {
  const gateway = raw?.trim();
  return gateway ? gateway : null;
}

/**
 * Preferencia IPFS que viaja en `agentStart`. Sin gateway configurado o con
 * la red privada (aún no disponible) se fuerza la transmisión directa.
 */
export type IpfsPreference = NonNullable<NonNullable<ApiOptions["preferences"]>["ipfs"]>;

export function ipfsPreference(choice: IpfsChoice, gateway: string | null): IpfsPreference | undefined {
  if (!gateway || !choice.ipfsEnabled || choice.ipfsNetwork !== "public") return undefined;
  return { enabled: true, network: choice.ipfsNetwork, retention: choice.ipfsRetention };
}
