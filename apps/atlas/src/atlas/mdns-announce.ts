/**
 * Anuncio mDNS de Atlas (SPEC-P2P-0001) — fallback de conveniencia para que
 * nodos en la misma LAN encuentren el bootstrap peer sin configurar
 * FHS_BOOTSTRAP_ADDRS a mano.
 *
 * En el modelo P2P la autenticación real la provee el protocolo Noise
 * (handshake Ed25519 en cada conexión libp2p), no la firma del TXT mDNS.
 */

import { Bonjour } from "bonjour-service";
import type { FhsIdentity } from "@rafex/galaxia-fhs-node";

export function announceAtlas(
  identity: FhsIdentity,
  multiaddrs: string[],
): { stop: () => void } {
  const instance = new Bonjour();

  const service = instance.publish({
    name: "fhs-atlas",
    type: "fhs-atlas",
    port: 4001,
    txt: {
      fhsVersion: "p2p-alpha",
      did: identity.did,
      addrs: multiaddrs.join(","),
    },
  });

  // bonjour-service tipa stop como CallableFunction (sin firma real)
  const stopService = service.stop as (callback: () => void) => void;

  return {
    stop: () => {
      stopService(() => instance.destroy());
    },
  };
}
