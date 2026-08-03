/**
 * Prueba de integración in-memory del stack FHS (Fase 1).
 * Dos nodos: n1 y n2 con transport @libp2p/memory.
 * Verifica: identidad, GossipSub, DHT y stream directo con LPP framing.
 */

import { describe, it, expect, afterEach } from "vitest";
import { memory } from "@libp2p/memory";
import { generateFhsIdentity } from "../identity.js";
import { createFhsNode } from "../create-node.js";
import { subscribe, publish } from "../gossipsub.js";
import { dhtPut, dhtGet, dhtBeaconKey } from "../dht.js";
import { handleFhsStream, openFhsStream } from "../stream.js";
import { FHS_STREAM_PROTOCOL } from "../constants.js";

 
const nodes: any[] = [];

afterEach(async () => {
  for (const n of nodes.splice(0)) {
    await n.stop().catch(() => {});
  }
});

async function makeNode(name: string, dhtMode: "server" | "client" = "client") {
  const identity = await generateFhsIdentity();
  const node = await createFhsNode({
    identity,
    listenAddrs: [`/memory/${name}`],
    dhtMode,
    transport: memory(),
  });
  await node.start();
  nodes.push(node);
  return { node, identity };
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

describe("identidad", () => {
  it("genera did:key:z... y peerId compatibles", async () => {
    const { identity } = await makeNode("identity-test");
    expect(identity.did).toMatch(/^did:key:z/);
    expect(identity.peerId.toString()).toBeTruthy();
  });
});

describe("gossipsub", () => {
  it("entrega un mensaje entre dos nodos", { timeout: 15_000 }, async () => {
    const { node: n1 } = await makeNode("gs-n1");
    const { node: n2 } = await makeNode("gs-n2");

    // Subscribir ANTES de conectar para que el mesh ya tenga la suscripción
    const received: unknown[] = [];
    subscribe(n2, "fhs/test", (msg) => received.push(msg));
    subscribe(n1, "fhs/test", () => {}); // n1 también suscribe para forzar mesh bidireccional

    // Conectar n2 a n1 y esperar mesh + intercambio de suscripciones
    const n1Addr = n1.getMultiaddrs()[0];
    await n2.dial(n1Addr);
    await wait(2000);

    await publish(n1, "fhs/test", { hello: "world" });
    await wait(2000);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ hello: "world" });
  });
});

describe("DHT", () => {
  it("pone y recupera un valor", { timeout: 30_000 }, async () => {
    const { node: n1 } = await makeNode("dht-n1", "server");
    const { node: n2 } = await makeNode("dht-n2", "server");

    const n1Addr = n1.getMultiaddrs()[0];
    await n2.dial(n1Addr);
    await wait(3000); // KadDHT necesita tiempo para estabilizar el routing table

    const key = dhtBeaconKey("did:key:zTest123");
    await dhtPut(n1, key, { did: "did:key:zTest123", test: true });

    const result = await dhtGet<{ did: string; test: boolean }>(n1, key);
    expect(result).not.toBeNull();
    expect(result?.did).toBe("did:key:zTest123");
  });
});

describe("stream directo", () => {
  it("intercambia mensajes con LPP framing", async () => {
    const { node: n1, identity: id1 } = await makeNode("stream-n1");
    const { node: n2 } = await makeNode("stream-n2");

    const n1Addr = n1.getMultiaddrs()[0];
    await n2.dial(n1Addr);
    await wait(400);

    const received: unknown[] = [];
    handleFhsStream(n1, (msg) => {
      received.push(msg);
    });

    // n2 abre stream directo a n1
    await openFhsStream(n2, id1.peerId, { type: "handshake", did: id1.did });
    await wait(400);

    expect(received).toHaveLength(1);
    expect((received[0] as { type: string }).type).toBe("handshake");
  });

  it("el protocolo registrado es " + FHS_STREAM_PROTOCOL, () => {
    expect(FHS_STREAM_PROTOCOL).toBe("/fhs/v1/0.1.0");
  });
});
