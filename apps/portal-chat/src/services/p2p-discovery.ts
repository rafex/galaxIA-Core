import { generateKeyPair, publicKeyFromRaw } from "@libp2p/crypto/keys";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import { gossipsub } from "@libp2p/gossipsub";
import { kadDHT } from "@libp2p/kad-dht";
import { identify } from "@libp2p/identify";
import { ping } from "@libp2p/ping";
import { webSockets } from "@libp2p/websockets";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { createLibp2p } from "libp2p";
import { CODE_P2P, multiaddr } from "@multiformats/multiaddr";
import { WebSocketsSecure } from "@multiformats/multiaddr-matcher";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58btc } from "multiformats/bases/base58";
import * as FhsProto from "@rafex/galaxia-fhs-protocol/generated";
import { TOPIC_NODES_ADVERTISE } from "@rafex/galaxia-fhs-protocol/constants";
import { decodeMessage, encodeMessage } from "@rafex/galaxia-fhs-protocol/wire";
import { normalizeBootstrapAddress } from "./p2p-config.js";
import { errorText, hintForTarget, noopDiagnostics, pageHostname, type DiagnosticsSink } from "./diagnostics.js";

const DISCOVERY_TIMEOUT_MS = 20_000;
const CLOCK_SKEW_MS = 5_000;

export interface P2pStream extends AsyncIterable<unknown> {
  send(data: Uint8Array): void;
}

export interface P2pConnection {
  newStream(protocol: string): Promise<P2pStream>;
  close?: () => Promise<void> | void;
}

interface PubsubMessageEvent {
  detail?: {
    topic?: string;
    data?: Uint8Array;
  };
}

interface PubsubService {
  subscribe(topic: string): void;
  unsubscribe(topic: string): void;
  addEventListener(type: "message", listener: (event: PubsubMessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: PubsubMessageEvent) => void): void;
}

interface DhtQueryEvent {
  name?: string;
  value?: Uint8Array;
}

interface DhtService {
  get(key: Uint8Array, options?: { signal?: AbortSignal }): AsyncIterable<DhtQueryEvent>;
}

export interface PortalP2pNode {
  dial(address: unknown): Promise<P2pConnection>;
  stop(): Promise<void>;
  services: {
    pubsub: PubsubService;
    dht: DhtService;
  };
}

export interface DiscoveredNavigator {
  connection: P2pConnection;
  did: string;
  multiaddr: string;
}

export async function createPortalP2pNode(
  privateKey: Awaited<ReturnType<typeof generateKeyPair>>,
): Promise<PortalP2pNode> {
  const node = await createLibp2p({
    privateKey,
    addresses: { listen: [] },
    transports: [webSockets()],
    connectionGater: {
      denyDialMultiaddr: (address) => !WebSocketsSecure.matches(address),
    },
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      ping: ping(),
      dht: kadDHT({
        clientMode: true,
        validators: { fhs: () => {} },
        selectors: { fhs: () => 0 },
      }),
      pubsub: gossipsub(),
    },
  });

  return node as unknown as PortalP2pNode;
}

export async function discoverNavigator(
  node: PortalP2pNode,
  bootstrapAddresses: string[],
  timeoutMs = DISCOVERY_TIMEOUT_MS,
  diag: DiagnosticsSink = noopDiagnostics,
): Promise<DiscoveredNavigator> {
  const pubsub = node.services.pubsub;
  pubsub.subscribe(TOPIC_NODES_ADVERTISE);

  // Estado local de este intento: permite que el error de timeout diga en qué
  // etapa se quedó (antes siempre decía "no se descubrió", aunque Navigator sí
  // se hubiera descubierto y lo que fallara fuera la conexión).
  let bootstrapConnected = false;
  let navigatorAdvertises = 0;
  let otherAdvertises = 0;
  const rejectedReasons = new Set<string>();
  const navigatorDialFailures = new Map<string, string>();
  let chosenConnection: P2pConnection | undefined;

  return new Promise<DiscoveredNavigator>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error(timeoutMessage())), timeoutMs);

    const finish = (error: Error | undefined, result?: DiscoveredNavigator): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pubsub.removeEventListener("message", onMessage);
      pubsub.unsubscribe(TOPIC_NODES_ADVERTISE);
      if (error) reject(error);
      else if (result) resolve(result);
    };

    const timeoutMessage = (): string => {
      const seconds = Math.round(timeoutMs / 1_000);
      if (!bootstrapConnected) {
        return `Tiempo agotado (${seconds} s) conectando al bootstrap: ${bootstrapAddresses.join(", ")}`;
      }
      if (navigatorAdvertises === 0) {
        if (rejectedReasons.size > 0) {
          return `Se recibieron anuncios pero fueron rechazados: ${[...rejectedReasons].join("; ")}`;
        }
        return otherAdvertises > 0
          ? `Conectado al bootstrap y a ${otherAdvertises} anuncio(s) de otros nodos, pero ninguno de Navigator en ${seconds} s`
          : `Conectado al bootstrap, pero no llegó ningún anuncio de Navigator en ${seconds} s (¿Navigator caído o sin malla GossipSub?)`;
      }
      const reachable = [...navigatorDialFailures].filter(([address]) => !isUnreachableLoopback(address));
      const failures = reachable.length > 0 ? reachable : [...navigatorDialFailures];
      if (failures.length > 0) {
        return `Navigator encontrado, pero falló la conexión a: ${failures.map(([address, message]) => `${address} (${message})`).join("; ")}`;
      }
      return `Navigator encontrado, pero la conexión no se completó en ${seconds} s`;
    };

    const onMessage = (event: PubsubMessageEvent): void => {
      if (event.detail?.topic !== TOPIC_NODES_ADVERTISE || !event.detail.data) return;
      void handleAdvertise(event.detail.data).catch((error: unknown) => {
        diag.record({ stage: "advertise", ok: false, message: `Error procesando un anuncio: ${errorText(error)}` });
      });
    };

    const handleAdvertise = async (bytes: Uint8Array): Promise<void> => {
      const inspected = await inspectSignedNodeAdvertise(bytes);
      if (!inspected.ok) {
        rejectedReasons.add(inspected.reason);
        diag.record({ stage: "advertise", ok: false, message: `Anuncio rechazado: ${inspected.reason}` });
        return;
      }
      const advertise = inspected.message;
      if (!isNavigatorAdvertise(advertise)) {
        otherAdvertises += 1;
        diag.record({
          stage: "advertise",
          ok: true,
          kind: "other",
          message: `Anuncio de ${advertise.beacon?.provider?.id || "nodo"} (no es Navigator)`,
          target: advertise.did,
        });
        return;
      }

      navigatorAdvertises += 1;
      diag.record({ stage: "advertise", ok: true, kind: "navigator", message: "Anuncio de Navigator verificado", target: advertise.did });

      const beacon = await readDhtBeacon(node, advertise.did, diag);
      const announced = beacon?.multiaddrs.length ? beacon.multiaddrs : advertise.multiaddrs;
      // Con --network host Navigator anuncia todas sus IPs, incluida la de
      // loopback, que desde otro equipo apunta a la máquina del navegador.
      const reachable = announced.filter((address) => !isUnreachableLoopback(address));
      const addresses = reachable.length > 0 ? reachable : announced;
      const peerId = peerIdFromDid(advertise.did);
      await Promise.all(addresses.map(async (rawAddress) => {
        let dialAddress = rawAddress;
        try {
          dialAddress = withPeerId(rawAddress, peerId);
          const connection = await node.dial(multiaddr(dialAddress));
          if (settled) {
            // libp2p reutiliza la conexión existente cuando ya hay una con
            // ese peer: cerrar "la sobrante" sin comparar cerraba la misma
            // conexión que se acababa de elegir (E2E-026).
            if (connection !== chosenConnection) await connection.close?.();
            return;
          }
          chosenConnection = connection;
          diag.record({ stage: "navigator-dial", ok: true, message: "Conectado a Navigator", target: dialAddress });
          finish(undefined, { connection, did: advertise.did, multiaddr: dialAddress });
        } catch (error: unknown) {
          // Todas las direcciones se marcan en paralelo; basta con que una
          // funcione. Pero cada fallo queda registrado con su motivo: fue
          // aquí donde se perdía el rechazo del certificado de :4010.
          const message = errorText(error);
          navigatorDialFailures.set(dialAddress, message);
          if (!settled) {
            diag.record({
              stage: "navigator-dial",
              ok: false,
              message,
              target: dialAddress,
              hint: hintForTarget(dialAddress, pageHostname()),
            });
          }
        }
      }));
    };

    pubsub.addEventListener("message", onMessage);

    void connectBootstraps().catch((error: unknown) => {
      finish(new Error(`No se pudo conectar a ningún bootstrap P2P: ${errorText(error)}`));
    });

    async function connectBootstraps(): Promise<void> {
      const errors: string[] = [];
      let pending = bootstrapAddresses.length;
      let connected = false;

      await new Promise<void>((resolve, reject) => {
        if (pending === 0) {
          reject(new Error("No hay direcciones bootstrap configuradas"));
          return;
        }

        for (const address of bootstrapAddresses) {
          void node.dial(multiaddr(address)).then(() => {
            diag.record({ stage: "bootstrap", ok: true, message: "Conectado al bootstrap", target: address });
            // Keep every successful bootstrap connection in the libp2p swarm;
            // resolve discovery as soon as the first one is ready.
            if (!connected) {
              connected = true;
              bootstrapConnected = true;
              resolve();
            }
          }).catch((error: unknown) => {
            const message = errorText(error);
            diag.record({
              stage: "bootstrap",
              ok: false,
              message,
              target: address,
              hint: hintForTarget(address, pageHostname()),
            });
            errors.push(`${address}: ${message}`);
            pending -= 1;
            if (pending === 0 && !connected) reject(new Error(errors.join(" | ")));
          });
        }
      });
    }
  });
}

function isNavigatorAdvertise(message: FhsProto.NodeAdvertiseMessage): boolean {
  return message.beacon?.provider?.id === "navigator";
}

export type InspectedAdvertise =
  | { ok: true; message: FhsProto.NodeAdvertiseMessage }
  | { ok: false; reason: string };

/**
 * Igual que decodeSignedNodeAdvertise, pero dice por qué se rechazó un
 * anuncio. El desfase de reloj es la causa que más importa al cambiar de red:
 * un equipo con la hora mal descarta todos los anuncios sin que nada falle.
 */
export async function inspectSignedNodeAdvertise(bytes: Uint8Array): Promise<InspectedAdvertise> {
  let message: FhsProto.NodeAdvertiseMessage;
  try {
    message = decodeMessage(FhsProto.NodeAdvertiseMessageSchema, bytes);
  } catch (error: unknown) {
    return { ok: false, reason: `no se pudo decodificar (${errorText(error)})` };
  }
  if (!message.did || message.signature.byteLength === 0 || !message.beacon) {
    return { ok: false, reason: "anuncio incompleto (falta did, firma o beacon)" };
  }
  const timestamp = Number(message.timestamp);
  const now = Date.now();
  if (timestamp > now + CLOCK_SKEW_MS) {
    return { ok: false, reason: `reloj desfasado: el anuncio llega ${Math.round((timestamp - now) / 1_000)} s en el futuro; revisa la hora de este equipo y del emisor` };
  }
  if (timestamp + message.ttlSeconds * 1_000 < now - CLOCK_SKEW_MS) {
    return { ok: false, reason: `anuncio vencido hace ${Math.round((now - timestamp - message.ttlSeconds * 1_000) / 1_000)} s; revisa la hora de este equipo y del emisor` };
  }
  try {
    const beaconHash = bytesToHex(sha256(encodeMessage(FhsProto.BeaconSchema, message.beacon)));
    const payload = `${message.did}:${beaconHash}:${timestamp}:${message.ttlSeconds}`;
    const publicKey = publicKeyFromRaw(rawPublicKeyFromDid(message.did));
    if (!await publicKey.verify(new TextEncoder().encode(payload), message.signature)) {
      return { ok: false, reason: `firma inválida del anuncio de ${message.did}` };
    }
  } catch (error: unknown) {
    return { ok: false, reason: `no se pudo verificar la firma (${errorText(error)})` };
  }
  return { ok: true, message };
}

export async function decodeSignedNodeAdvertise(bytes: Uint8Array): Promise<FhsProto.NodeAdvertiseMessage | null> {
  const inspected = await inspectSignedNodeAdvertise(bytes);
  return inspected.ok ? inspected.message : null;
}

export async function readDhtBeacon(
  node: PortalP2pNode,
  did: string,
  diag: DiagnosticsSink = noopDiagnostics,
): Promise<FhsProto.DhtBeaconRecord | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3_000);
  try {
    const key = new TextEncoder().encode(`/fhs/beacon/${did}`);
    for await (const event of node.services.dht.get(key, { signal: controller.signal })) {
      if (event.name !== "VALUE" || !event.value) continue;
      const record = decodeMessage(FhsProto.DhtBeaconRecordSchema, event.value);
      if (record.did !== did || record.signature.byteLength === 0 || !record.beacon) continue;
      const beaconHash = bytesToHex(sha256(encodeMessage(FhsProto.BeaconSchema, record.beacon)));
      const payload = `${record.did}:${beaconHash}:${Number(record.publishedAt)}:${Number(record.expiresAt)}`;
      const publicKey = publicKeyFromRaw(rawPublicKeyFromDid(record.did));
      if (!await publicKey.verify(new TextEncoder().encode(payload), record.signature)) continue;
      if (Number(record.expiresAt) < Date.now() - CLOCK_SKEW_MS) continue;
      diag.record({ stage: "beacon", ok: true, message: `Beacon DHT con ${record.multiaddrs.length} dirección(es)`, target: did });
      return record;
    }
    diag.record({ stage: "beacon", ok: true, message: "Sin beacon DHT válido; se usan las direcciones del anuncio", target: did });
  } catch (error: unknown) {
    // No es fatal: el anuncio firmado ya trae direcciones.
    const message = controller.signal.aborted ? "la consulta DHT superó 3 s" : errorText(error);
    diag.record({ stage: "beacon", ok: true, message: `Beacon DHT no disponible (${message}); se usan las direcciones del anuncio`, target: did });
    return null;
  } finally {
    clearTimeout(timeout);
  }
  return null;
}

function rawPublicKeyFromDid(did: string): Uint8Array {
  if (!did.startsWith("did:key:z")) throw new Error("DID FHS inválido");
  const encoded = base58btc.decode(did.slice("did:key:".length));
  if (encoded[0] !== 0xed || encoded[1] !== 0x01 || encoded.byteLength !== 34) throw new Error("DID FHS no es Ed25519");
  return encoded.slice(2);
}

function peerIdFromDid(did: string): string {
  return peerIdFromPublicKey(publicKeyFromRaw(rawPublicKeyFromDid(did))).toString();
}

function withPeerId(rawAddress: string, peerId: string): string {
  const address = multiaddr(normalizeBootstrapAddress(rawAddress));
  return address.decapsulateCode(CODE_P2P).encapsulate(`/p2p/${peerId}`).toString();
}

function isUnreachableLoopback(address: string): boolean {
  const host = /^\/(?:ip4|ip6|dns4|dns6|dns)\/([^/]+)/.exec(address)?.[1] ?? "";
  const loopback = (value: string) => value === "localhost" || value === "::1" || /^127\./.test(value);
  return loopback(host) && !loopback(pageHostname());
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
