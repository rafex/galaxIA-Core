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

  it("subscribes before dialing the bootstrap and then pins the discovered peer", async () => {
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
      multiaddrs: ["/ip4/192.168.3.175/tcp/4010/tls/ws"],
      timestamp: BigInt(timestamp),
      ttlSeconds,
      trustLevel: "community",
      signature: await privateKey.sign(new TextEncoder().encode(payload)),
    }));

    let onMessage: ((event: { detail?: { topic?: string; data?: Uint8Array } }) => void) | undefined;
    const dialed: string[] = [];
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
        dialed.push(address.toString());
        if (dialed.length === 1) onMessage?.({ detail: { topic: TOPIC_NODES_ADVERTISE, data: advertise } });
        return { newStream: async () => ({ send: () => {}, [Symbol.asyncIterator]: async function* () {} }) };
      },
      stop: async () => {},
    };

    const result = await discoverNavigator(node, ["/ip4/192.168.3.175/tcp/4001/tls/ws"], 1_000);
    expect(dialed[0]).toBe("/ip4/192.168.3.175/tcp/4001/tls/ws");
    expect(dialed[1]).toContain("/p2p/");
    expect(result.did).toBe(did);
  });
});
