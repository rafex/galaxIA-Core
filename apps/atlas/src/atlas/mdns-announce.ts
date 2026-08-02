import { Bonjour, type Service } from "bonjour-service";
import { signPayload, type NodeIdentity } from "@rafex/galaxia-fhs-protocol";

/**
 * Anuncio mDNS del Registry (SPEC-P2P-0001, fase 1) — fallback/conveniencia
 * para que un nodo en la misma LAN encuentre la dirección del Registry sin
 * configurar `REGISTRY_URL` a mano. Nunca reemplaza el Registry ni cambia
 * el protocolo `hello`/`register`/Pulse — solo resuelve "¿dónde está?".
 *
 * El anuncio va firmado con la identidad Ed25519 del propio Registry
 * (DEC-0032) — un nodo puede verificar que viene de quien dice ser, y
 * opcionalmente anclar (`REGISTRY_EXPECTED_DID`) cuál `did` espera para su
 * comunidad. Sin ese anclaje, cualquier identidad válida (incluida una
 * generada por un atacante) pasa la verificación de firma — el anclaje es
 * lo que cierra el riesgo de raíz, no la firma por sí sola.
 */
export function announceRegistry(
  identity: NodeIdentity,
  port: number,
  tlsEnabled: boolean
): { stop: () => void } {
  const instance = new Bonjour();
  const timestamp = Date.now();
  const signature = signPayload(identity.privateKey, `${identity.did}:${timestamp}`);

  const service: Service = instance.publish({
    name: "fhs-registry",
    type: "fhs-registry",
    port,
    txt: {
      fhsVersion: "0.1",
      tls: String(tlsEnabled),
      did: identity.did,
      ts: String(timestamp),
      sig: signature,
    },
  });

  // bonjour-service tipa `Service.stop` como `CallableFunction` (sin firma
  // real) — se acota aquí a la firma real documentada por la librería en
  // vez de dejar pasar ese tipo laxo sin acotar.
  const stopService = service.stop as (callback: () => void) => void;

  return {
    stop: () => {
      stopService(() => instance.destroy());
    },
  };
}
