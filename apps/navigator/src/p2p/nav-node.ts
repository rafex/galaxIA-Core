/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return */
/**
 * Nodo libp2p del Navigator (DEC-0088).
 * Mismo stack que star/atlas; añade PeerCache y BidCollector.
 */

import { createLibp2p } from "libp2p";
import { webSockets } from "@libp2p/websockets";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { kadDHT } from "@libp2p/kad-dht";
import { floodsub } from "@libp2p/floodsub";
import { identify } from "@libp2p/identify";
import { ping } from "@libp2p/ping";
import {
  generateKeyPair,
  privateKeyToProtobuf,
  privateKeyFromProtobuf,
} from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { multiaddr } from "@multiformats/multiaddr";
import { base58btc } from "multiformats/bases/base58";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fromString, toString } from "uint8arrays";
import type { FhsProto } from "@rafex/galaxia-fhs-protocol";
import { type ProtoCodec } from "./p2p-wire.js";
import { FhsProto as Wire } from "@rafex/galaxia-fhs-protocol";

type MissionBidMessage = FhsProto.MissionBidMessage;

// ── Alias de tipo ──────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FhsNode = any;

export interface FhsIdentity {
  did: string;
  peerId: unknown;
  privateKey: unknown;
}

// ── PeerCache ──────────────────────────────────────────────────────────────────

export interface PeerEntry {
  did: string;
  beacon: FhsProto.Beacon;
  multiaddrs: string[];
  trustLevel: string;
  reputationScore: number;
  lastSeen: number;
  peerType: string;
  capabilities: string[];
}

export class PeerCache {
  private peers = new Map<string, PeerEntry>();

  upsert(msg: FhsProto.NodeAdvertiseMessage): void {
    const beacon = msg.beacon;
    if (!beacon) return;
    const capabilities = [
      ...beacon.capabilities.map((capability) => capability.id),
      ...beacon.agentCapabilities.map((capability) => capability.id),
    ];
    const peerType = beacon.provider?.type === Wire.ProviderType.STAR
      ? "star"
      : beacon.provider?.type === Wire.ProviderType.SATELLITE
        ? "satellite"
        : beacon.provider?.type === Wire.ProviderType.NOVA
          ? "nova"
          : "unknown";

    this.peers.set(msg.did, {
      did: msg.did,
      beacon,
      multiaddrs: msg.multiaddrs,
      trustLevel: msg.trustLevel,
      reputationScore: 0.5,
      lastSeen: Date.now(),
      peerType,
      capabilities,
    });
  }

  getStars(): PeerEntry[] {
    return [...this.peers.values()].filter((p) => p.peerType === "star");
  }

  getSatellites(): PeerEntry[] {
    return [...this.peers.values()].filter((p) => p.peerType === "satellite");
  }

  getByCapability(capability: string): PeerEntry[] {
    return [...this.peers.values()].filter((p) =>
      p.capabilities.includes(capability)
    );
  }

  all(): PeerEntry[] {
    return [...this.peers.values()];
  }
}

// ── BidCollector ───────────────────────────────────────────────────────────────

interface BidWaiter {
  bids: MissionBidMessage[];
  resolve: (bids: MissionBidMessage[]) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BidCollector {
  private pending = new Map<string, BidWaiter>();

  open(missionId: string, deadlineMs: number): Promise<MissionBidMessage[]> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const waiter = this.pending.get(missionId);
        if (waiter) {
          this.pending.delete(missionId);
          resolve(waiter.bids);
        }
      }, deadlineMs);
      this.pending.set(missionId, { bids: [], resolve, timer });
    });
  }

  addBid(bid: MissionBidMessage): void {
    const waiter = this.pending.get(bid.missionId);
    if (waiter) waiter.bids.push(bid);
  }

  close(missionId: string): void {
    const waiter = this.pending.get(missionId);
    if (waiter) {
      clearTimeout(waiter.timer);
      this.pending.delete(missionId);
      waiter.resolve(waiter.bids);
    }
  }
}

// ── Identidad FHS ─────────────────────────────────────────────────────────────

interface PersistedIdentity {
  privateKeyHex: string;
}

export async function loadOrCreateFhsIdentity(keyPath: string): Promise<FhsIdentity> {
  if (existsSync(keyPath)) {
    const raw = JSON.parse(readFileSync(keyPath, "utf8")) as PersistedIdentity;
    const bytes = fromString(raw.privateKeyHex, "hex");
    const privateKey = privateKeyFromProtobuf(bytes);
    const peerId = peerIdFromPrivateKey(privateKey);
    const pubKeyBytes = (privateKey.publicKey as { raw: Uint8Array }).raw;
    const did = `did:key:z${base58btc.baseEncode(Uint8Array.from([0xed, 0x01, ...pubKeyBytes]))}`;
    return { did, peerId, privateKey };
  }

  const privateKey = await generateKeyPair("Ed25519");
  const bytes = privateKeyToProtobuf(privateKey);
  const persisted: PersistedIdentity = { privateKeyHex: toString(bytes, "hex") };
  writeFileSync(keyPath, JSON.stringify(persisted, null, 2), "utf8");

  const peerId = peerIdFromPrivateKey(privateKey);
  const pubKeyBytes = (privateKey.publicKey as { raw: Uint8Array }).raw;
  const did = `did:key:z${base58btc.baseEncode(Uint8Array.from([0xed, 0x01, ...pubKeyBytes]))}`;
  return { did, peerId, privateKey };
}

// ── Crear nodo Navigator ───────────────────────────────────────────────────────

export interface NavNodeConfig {
  identity: FhsIdentity;
  listenAddrs?: string[];
  announceAddrs?: string[];
  bootstrapAddrs?: string[];
}

export async function createNavNode(config: NavNodeConfig): Promise<FhsNode> {
  const {
    identity,
    listenAddrs = ["/ip4/0.0.0.0/tcp/4010/ws"],
    announceAddrs,
    bootstrapAddrs = [],
  } = config;

  const addresses: { listen: string[]; announce?: string[] } = { listen: listenAddrs };
  if (announceAddrs && announceAddrs.length > 0) {
    addresses.announce = announceAddrs;
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const node: FhsNode = await createLibp2p({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    privateKey: identity.privateKey as any,
    addresses,
    transports: [webSockets()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      ping: ping(),
      dht: kadDHT({
        clientMode: true,
        validators: { fhs: (_k: Uint8Array, _v: Uint8Array) => {} },
        selectors: { fhs: (_k: Uint8Array, _rs: Uint8Array[]) => 0 },
      }),
      pubsub: floodsub(),
    },
  });

  await node.start();

  for (const addr of bootstrapAddrs) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    node.dial(multiaddr(addr) as any).catch(() => {});
  }

  return node;
}

// ── PubSub helpers ─────────────────────────────────────────────────────────────

export function pubsubPublish<T>(node: FhsNode, topic: string, msg: T, codec: ProtoCodec<T>): void {
  const bytes = codec.encode(msg);
  (node.services.pubsub.publish(topic, bytes) as Promise<unknown>).catch((e: unknown) => {
    console.error(`[nav-pubsub] error en ${topic}:`, e);
  });
}

export function pubsubSubscribe<T>(
  node: FhsNode,
  topic: string,
  handler: (msg: T) => void,
  codec: ProtoCodec<T>
): void {
  node.services.pubsub.subscribe(topic);
  node.services.pubsub.addEventListener(
    "message",
    (evt: { detail: { topic: string; data: Uint8Array } }) => {
      if (evt.detail.topic !== topic) return;
      try {
        handler(codec.decode(evt.detail.data));
      } catch { /* ignorar */ }
    }
  );
}

// ── DHT helper ────────────────────────────────────────────────────────────────

export async function dhtPut<T>(node: FhsNode, key: string, value: T, codec: ProtoCodec<T>): Promise<void> {
  const keyBytes = fromString(key, "utf8");
  const valueBytes = codec.encode(value);
  const signal = AbortSignal.timeout(5_000);
  for await (const _ of node.services.dht.put(keyBytes, valueBytes, { signal })) {
    void _;
  }
}
