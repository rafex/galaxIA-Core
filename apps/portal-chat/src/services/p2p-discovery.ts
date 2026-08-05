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
): Promise<DiscoveredNavigator> {
  const pubsub = node.services.pubsub;
  pubsub.subscribe(TOPIC_NODES_ADVERTISE);

  return new Promise<DiscoveredNavigator>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error("No se descubrió un Navigator activo mediante GossipSub/DHT")), timeoutMs);

    const finish = (error: Error | undefined, result?: DiscoveredNavigator): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pubsub.removeEventListener("message", onMessage);
      pubsub.unsubscribe(TOPIC_NODES_ADVERTISE);
      if (error) reject(error);
      else if (result) resolve(result);
    };

    const onMessage = (event: PubsubMessageEvent): void => {
      if (event.detail?.topic !== TOPIC_NODES_ADVERTISE || !event.detail.data) return;
      void handleAdvertise(event.detail.data).catch(() => {});
    };

    const handleAdvertise = async (bytes: Uint8Array): Promise<void> => {
      const advertise = await decodeSignedNodeAdvertise(bytes);
      if (!advertise || !isNavigatorAdvertise(advertise)) return;

      const beacon = await readDhtBeacon(node, advertise.did);
      const addresses = beacon?.multiaddrs.length ? beacon.multiaddrs : advertise.multiaddrs;
      const peerId = peerIdFromDid(advertise.did);
      await Promise.all(addresses.map(async (rawAddress) => {
        let dialAddress: string;
        try {
          dialAddress = withPeerId(rawAddress, peerId);
          const connection = await node.dial(multiaddr(dialAddress));
          if (settled) {
            await connection.close?.();
            return;
          }
          finish(undefined, { connection, did: advertise.did, multiaddr: dialAddress });
        } catch {
          // All signed/derived addresses are dialed concurrently.
        }
      }));
    };

    pubsub.addEventListener("message", onMessage);

    void connectBootstraps().catch((error: unknown) => {
      finish(new Error(`No se pudo conectar a ningún bootstrap P2P: ${error instanceof Error ? error.message : String(error)}`));
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
            // Keep every successful bootstrap connection in the libp2p swarm;
            // resolve discovery as soon as the first one is ready.
            if (!connected) {
              connected = true;
              resolve();
            }
          }).catch((error: unknown) => {
            errors.push(`${address}: ${error instanceof Error ? error.message : String(error)}`);
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

export async function decodeSignedNodeAdvertise(bytes: Uint8Array): Promise<FhsProto.NodeAdvertiseMessage | null> {
  try {
    const message = decodeMessage(FhsProto.NodeAdvertiseMessageSchema, bytes);
    if (!message.did || message.signature.byteLength === 0 || !message.beacon) return null;
    const timestamp = Number(message.timestamp);
    const now = Date.now();
    if (timestamp > now + CLOCK_SKEW_MS || timestamp + message.ttlSeconds * 1_000 < now - CLOCK_SKEW_MS) return null;

    const beaconHash = bytesToHex(sha256(encodeMessage(FhsProto.BeaconSchema, message.beacon)));
    const payload = `${message.did}:${beaconHash}:${timestamp}:${message.ttlSeconds}`;
    const publicKey = publicKeyFromRaw(rawPublicKeyFromDid(message.did));
    if (!await publicKey.verify(new TextEncoder().encode(payload), message.signature)) return null;
    return message;
  } catch {
    return null;
  }
}

async function readDhtBeacon(node: PortalP2pNode, did: string): Promise<FhsProto.DhtBeaconRecord | null> {
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
      return record;
    }
  } catch {
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

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
