import { create } from "@bufbuild/protobuf";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58btc } from "multiformats/bases/base58";
import { describe, expect, it } from "vitest";
import * as FhsProto from "@rafex/galaxia-fhs-protocol/generated";
import { encodeMessage } from "@rafex/galaxia-fhs-protocol/wire";
import { TOPIC_NODES_ADVERTISE } from "@rafex/galaxia-fhs-protocol/constants";
import { discoverNavigator, inspectSignedNodeAdvertise, type PortalP2pNode } from "../src/services/p2p-discovery.js";
import { DiagnosticsLog } from "../src/services/diagnostics.js";

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signedAdvertise(options: { providerId: string; multiaddrs: string[]; timestamp?: number; ttlSeconds?: number }) {
  const privateKey = await generateKeyPair("Ed25519");
  const did = `did:key:${base58btc.encode(Uint8Array.from([0xed, 0x01, ...privateKey.publicKey.raw]))}`;
  const beacon = create(FhsProto.BeaconSchema, {
    fhsVersion: "0.1",
    provider: create(FhsProto.ProviderIdentitySchema, {
      id: options.providerId,
      type: FhsProto.ProviderType.MULTI,
      visibility: FhsProto.Visibility.COMMUNITY,
      name: options.providerId,
    }),
  });
  const timestamp = options.timestamp ?? Date.now();
  const ttlSeconds = options.ttlSeconds ?? 60;
  const payload = `${did}:${bytesToHex(sha256(encodeMessage(FhsProto.BeaconSchema, beacon)))}:${timestamp}:${ttlSeconds}`;
  const bytes = encodeMessage(FhsProto.NodeAdvertiseMessageSchema, create(FhsProto.NodeAdvertiseMessageSchema, {
    did,
    beacon,
    multiaddrs: options.multiaddrs,
    timestamp: BigInt(timestamp),
    ttlSeconds,
    trustLevel: "community",
    signature: await privateKey.sign(new TextEncoder().encode(payload)),
  }));
  return { did, bytes };
}

/** Nodo simulado: el bootstrap conecta, publica los anuncios y el dial a Navigator falla como en Firefox. */
function fakeNode(advertises: Uint8Array[], navigatorDial: (address: string) => Promise<unknown>): PortalP2pNode {
  let onMessage: ((event: { detail?: { topic?: string; data?: Uint8Array } }) => void) | undefined;
  return {
    services: {
      pubsub: {
        subscribe: () => {},
        unsubscribe: () => {},
        addEventListener: (_type, listener) => { onMessage = listener; },
        removeEventListener: () => {},
      },
      dht: { get: async function* () {} },
    },
    dial: async (address: unknown) => {
      const value = String(address);
      if (!value.includes("/p2p/")) {
        setTimeout(() => {
          for (const data of advertises) onMessage?.({ detail: { topic: TOPIC_NODES_ADVERTISE, data } });
        }, 5);
        return { newStream: async () => ({ send: () => {}, [Symbol.asyncIterator]: async function* () {} }) };
      }
      return navigatorDial(value) as never;
    },
    stop: async () => {},
  } as PortalP2pNode;
}

describe("portal P2P discovery failures", () => {
  it("names the Navigator address whose WebSocket failed instead of claiming it was not discovered", async () => {
    const navigator = await signedAdvertise({
      providerId: "navigator",
      multiaddrs: ["/ip4/127.0.0.1/tcp/4010/tls/ws", "/ip4/192.168.1.139/tcp/4010/tls/ws"],
    });
    const log = new DiagnosticsLog(300, null);
    log.beginAttempt(0);
    const node = fakeNode([navigator.bytes], async (address) => {
      const host = address.includes("127.0.0.1") ? "127.0.0.1" : "192.168.1.139";
      throw { type: "error", target: { url: `wss://${host}:4010` } };
    });

    const error = await discoverNavigator(node, ["/ip4/192.168.1.139/tcp/4001/tls/ws"], 200, log).catch((reason: Error) => reason);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Navigator encontrado");
    expect((error as Error).message).toContain("wss://192.168.1.139:4010");
    expect((error as Error).message).not.toContain("127.0.0.1");
    // La dirección de loopback ni se marca desde otro equipo.
    const failed = log.list().filter((entry) => entry.stage === "navigator-dial" && !entry.ok);
    expect(failed).toHaveLength(1);
    expect(failed.find((entry) => entry.target?.includes("192.168.1.139"))?.hint).toContain("https://192.168.1.139:4010/");
    expect(log.summary()).toContain("Navigator encontrado");
  });

  it("keeps the chosen connection when another announced address resolves to the same one (E2E-026)", async () => {
    // Navigator con --network host anuncia varias IPs alcanzables; libp2p
    // devuelve la misma conexión para cada dial al mismo peer.
    const navigator = await signedAdvertise({
      providerId: "navigator",
      multiaddrs: [
        "/ip4/127.0.0.1/tcp/4010/tls/ws",
        "/ip4/192.168.1.139/tcp/4010/tls/ws",
        "/ip4/192.168.3.175/tcp/4010/tls/ws",
      ],
    });
    let closed = 0;
    const dialed: string[] = [];
    const shared = { newStream: async () => ({}), close: () => { closed += 1; } };
    const node = fakeNode([navigator.bytes], async (address) => {
      dialed.push(address);
      await new Promise((resolve) => setTimeout(resolve, address.includes("192.168.3.175") ? 20 : 1));
      return shared;
    });

    const discovered = await discoverNavigator(node, ["/ip4/192.168.1.139/tcp/4001/tls/ws"], 500);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(discovered.connection).toBe(shared);
    expect(closed).toBe(0);
    expect(dialed.some((address) => address.includes("127.0.0.1"))).toBe(false);
  });

  it("says when only non-Navigator nodes are advertising", async () => {
    const star = await signedAdvertise({ providerId: "star", multiaddrs: ["/ip4/192.168.1.139/tcp/4002/tls/ws"] });
    const node = fakeNode([star.bytes], async () => { throw new Error("no debería dialear"); });

    const error = await discoverNavigator(node, ["/ip4/192.168.1.139/tcp/4001/tls/ws"], 100).catch((reason: Error) => reason);

    expect((error as Error).message).toContain("1 anuncio(s) de otros nodos, pero ninguno de Navigator");
  });

  it("explains a rejected advertise caused by clock skew", async () => {
    const expired = await signedAdvertise({
      providerId: "navigator",
      multiaddrs: ["/ip4/192.168.1.139/tcp/4010/tls/ws"],
      timestamp: Date.now() - 120_000,
      ttlSeconds: 60,
    });
    const inspected = await inspectSignedNodeAdvertise(expired.bytes);
    expect(inspected.ok).toBe(false);
    expect(inspected.ok ? "" : inspected.reason).toContain("vencido");

    const node = fakeNode([expired.bytes], async () => { throw new Error("no debería dialear"); });
    const error = await discoverNavigator(node, ["/ip4/192.168.1.139/tcp/4001/tls/ws"], 100).catch((reason: Error) => reason);
    expect((error as Error).message).toContain("rechazados");
    expect((error as Error).message).toContain("revisa la hora");
  });
});
