import { create } from "@bufbuild/protobuf";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { sha256 } from "@noble/hashes/sha2.js";
import { base58btc } from "multiformats/bases/base58";
import { describe, expect, it } from "vitest";
import * as FhsProto from "@rafex/galaxia-fhs-protocol/generated";
import { encodeMessage } from "@rafex/galaxia-fhs-protocol/wire";
import { decodeSignedNodeAdvertise, discoverNavigator } from "../src/services/p2p-discovery.js";
import { TOPIC_NODES_ADVERTISE } from "@rafex/galaxia-fhs-protocol/constants";

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("portal P2P discovery", () => {
  it("accepts only a fresh, signed Navigator advertisement", async () => {
    const privateKey = await generateKeyPair("Ed25519");
    const rawPublicKey = privateKey.publicKey.raw;
    const did = `did:key:${base58btc.encode(Uint8Array.from([0xed, 0x01, ...rawPublicKey]))}`;
    const beacon = create(FhsProto.BeaconSchema, {
      fhsVersion: "0.1",
      provider: create(FhsProto.ProviderIdentitySchema, {
        id: "navigator",
        type: FhsProto.ProviderType.MULTI,
        visibility: FhsProto.Visibility.COMMUNITY,
        name: "Navigator FHS",
      }),
    });
    const timestamp = Date.now();
    const ttlSeconds = 60;
    const payload = `${did}:${bytesToHex(sha256(encodeMessage(FhsProto.BeaconSchema, beacon)))}:${timestamp}:${ttlSeconds}`;
    const message = create(FhsProto.NodeAdvertiseMessageSchema, {
      did,
      beacon,
      multiaddrs: ["/ip4/192.168.3.175/tcp/4010/tls/ws"],
      timestamp: BigInt(timestamp),
      ttlSeconds,
      trustLevel: "community",
      signature: await privateKey.sign(new TextEncoder().encode(payload)),
    });

    const decoded = await decodeSignedNodeAdvertise(encodeMessage(FhsProto.NodeAdvertiseMessageSchema, message));
    expect(decoded?.did).toBe(did);
    expect(decoded?.multiaddrs).toEqual(["/ip4/192.168.3.175/tcp/4010/tls/ws"]);
  });

  it("rejects a tampered advertisement", async () => {
    const privateKey = await generateKeyPair("Ed25519");
    const rawPublicKey = privateKey.publicKey.raw;
    const did = `did:key:${base58btc.encode(Uint8Array.from([0xed, 0x01, ...rawPublicKey]))}`;
    const beacon = create(FhsProto.BeaconSchema, {
      fhsVersion: "0.1",
      provider: create(FhsProto.ProviderIdentitySchema, {
        id: "navigator",
        type: FhsProto.ProviderType.MULTI,
        visibility: FhsProto.Visibility.COMMUNITY,
        name: "Navigator FHS",
      }),
    });
    const timestamp = Date.now();
    const ttlSeconds = 60;
    const payload = `${did}:${bytesToHex(sha256(encodeMessage(FhsProto.BeaconSchema, beacon)))}:${timestamp}:${ttlSeconds}`;
    const signature = await privateKey.sign(new TextEncoder().encode(payload));
    const message = create(FhsProto.NodeAdvertiseMessageSchema, {
      did,
      beacon,
      multiaddrs: ["/ip4/192.168.3.175/tcp/4010/tls/ws"],
      timestamp: BigInt(timestamp),
      ttlSeconds,
      trustLevel: "community",
      signature,
    });

    const tampered = create(FhsProto.NodeAdvertiseMessageSchema, {
      ...message,
      did: "did:key:z6Mktampered",
    });
    await expect(decodeSignedNodeAdvertise(encodeMessage(FhsProto.NodeAdvertiseMessageSchema, tampered))).resolves.toBeNull();
  });

  it("dials all bootstraps and Navigator addresses concurrently", async () => {
    const privateKey = await generateKeyPair("Ed25519");
    const rawPublicKey = privateKey.publicKey.raw;
    const did = `did:key:${base58btc.encode(Uint8Array.from([0xed, 0x01, ...rawPublicKey]))}`;
    const beacon = create(FhsProto.BeaconSchema, {
      fhsVersion: "0.1",
      provider: create(FhsProto.ProviderIdentitySchema, {
        id: "navigator",
        type: FhsProto.ProviderType.MULTI,
        visibility: FhsProto.Visibility.COMMUNITY,
        name: "Navigator FHS",
      }),
    });
    const timestamp = Date.now();
    const ttlSeconds = 60;
    const payload = `${did}:${bytesToHex(sha256(encodeMessage(FhsProto.BeaconSchema, beacon)))}:${timestamp}:${ttlSeconds}`;
    const advertise = encodeMessage(FhsProto.NodeAdvertiseMessageSchema, create(FhsProto.NodeAdvertiseMessageSchema, {
      did,
      beacon,
      multiaddrs: [
        "/ip4/192.168.3.175/tcp/4010/tls/ws",
        "/ip4/192.168.3.175/tcp/4011/tls/ws",
      ],
      timestamp: BigInt(timestamp),
      ttlSeconds,
      trustLevel: "community",
      signature: await privateKey.sign(new TextEncoder().encode(payload)),
    }));

    let onMessage: ((event: { detail?: { topic?: string; data?: Uint8Array } }) => void) | undefined;
    const dialed: string[] = [];
    let advertised = false;
    const node = {
      services: {
        pubsub: {
          subscribe: () => {},
          unsubscribe: () => {},
          addEventListener: (_type: "message", listener: typeof onMessage) => { onMessage = listener; },
          removeEventListener: () => {},
        },
        dht: {
          get: async function* () { /* El test usa la firma del GossipSub. */ },
        },
      },
      dial: async (address: { toString(): string }) => {
        const value = address.toString();
        dialed.push(value);
        if (!value.includes("/p2p/")) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          if (!advertised && dialed.filter((item) => !item.includes("/p2p/")).length === 2) {
            advertised = true;
            onMessage?.({ detail: { topic: TOPIC_NODES_ADVERTISE, data: advertise } });
          }
        } else {
          await new Promise((resolve) => setTimeout(resolve, value.includes("/tcp/4010/") ? 10 : 0));
        }
        return { newStream: async () => ({ send: () => {}, [Symbol.asyncIterator]: async function* () {} }) };
      },
      stop: async () => {},
    };

    const result = await discoverNavigator(node, [
      "/ip4/192.168.3.175/tcp/4001/tls/ws",
      "/ip4/192.168.3.175/tcp/4002/tls/ws",
    ], 1_000);
    expect(dialed.slice(0, 2)).toEqual([
      "/ip4/192.168.3.175/tcp/4001/tls/ws",
      "/ip4/192.168.3.175/tcp/4002/tls/ws",
    ]);
    expect(dialed.filter((item) => item.includes("/p2p/")).length).toBe(2);
    expect(result.did).toBe(did);
  });
});
