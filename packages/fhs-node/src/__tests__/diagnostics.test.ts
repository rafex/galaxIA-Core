/**
 * dialBootstraps: el caso del arranque simultáneo tras reiniciar el host —
 * el nodo intenta conectarse a un Atlas que todavía no escucha.
 */
import { describe, it, expect, afterEach } from "vitest";
import { memory } from "@libp2p/memory";
import { generateFhsIdentity } from "../identity.js";
import { createFhsNode } from "../create-node.js";
import { dialBootstraps, errorMessage, nodeStatus, type DiagLogger, type DiagNode } from "../diagnostics.js";

const nodes: Array<{ stop(): Promise<void> }> = [];

afterEach(async () => {
  for (const node of nodes.splice(0)) await node.stop().catch(() => {});
});

function capturingLogger() {
  const lines: string[] = [];
  const logger: DiagLogger = {
    info: (message) => lines.push(`info ${message}`),
    warn: (message) => lines.push(`warn ${message}`),
  };
  return { lines, logger };
}

async function makeNode(name: string) {
  const node = await createFhsNode({
    identity: await generateFhsIdentity(),
    listenAddrs: [`/memory/${name}`],
    dhtMode: "server",
    transport: memory(),
    logConnections: false,
  });
  nodes.push(node);
  return node;
}

async function until(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condición no cumplida a tiempo");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("dialBootstraps", () => {
  it("retries until the bootstrap starts listening and logs every failure", async () => {
    // @libp2p/memory acepta el dial aunque el destino no haya arrancado, así
    // que no sirve para simular "Atlas todavía no escucha": se usa un nodo
    // simulado que rechaza los primeros dials como lo haría el socket real.
    const atlasPeerId = "12D3KooWL2kvLw4MgPbTTpgKBMsHfVjnpp26AVL54VwWkantYHoL";
    let attempts = 0;
    const tagged: string[] = [];
    const listeners = new Map<string, () => void>();
    const fake: DiagNode = {
      peerId: { toString: () => "12D3KooWJNDdrDDeJS15GyrEyqzuXzdZF5f1UXKTQGZEHPfrVdsi" },
      getMultiaddrs: () => [],
      getPeers: () => [],
      getConnections: () => [],
      dial: () => {
        attempts += 1;
        if (attempts < 3) return Promise.reject(Object.assign(new Error("connect ECONNREFUSED 192.168.1.139:4001"), { code: "ECONNREFUSED" }));
        return Promise.resolve({});
      },
      peerStore: {
        merge: (peerId) => {
          tagged.push(peerId.toString());
          return Promise.resolve();
        },
      },
      addEventListener: (type, listener) => { listeners.set(type, listener as () => void); },
    };
    const { lines, logger } = capturingLogger();

    dialBootstraps(fake, [`/ip4/192.168.1.139/tcp/4001/tls/ws/p2p/${atlasPeerId}`], logger, { initialDelayMs: 10, maxDelayMs: 20 });
    await until(() => lines.some((line) => line.startsWith("info bootstrap conectado")));

    expect(attempts).toBe(3);
    expect(lines.filter((line) => line.startsWith("warn bootstrap no disponible"))).toHaveLength(2);
    expect(lines[0]).toContain("ECONNREFUSED");
    expect(lines.at(-1)).toContain("(intento 3)");
    expect(tagged).toEqual([atlasPeerId]);
    expect(listeners.has("stop")).toBe(true);
  });

  it("reconnects when the bootstrap drops after connecting (Atlas restarted)", async () => {
    const atlasPeerId = "12D3KooWL2kvLw4MgPbTTpgKBMsHfVjnpp26AVL54VwWkantYHoL";
    let dials = 0;
    const listeners = new Map<string, Set<(event: { detail: unknown }) => void>>();
    const emit = (type: string, detail: unknown) => {
      for (const listener of [...(listeners.get(type) ?? [])]) listener({ detail });
    };
    const fake: DiagNode = {
      peerId: { toString: () => "self" },
      getMultiaddrs: () => [],
      getPeers: () => [],
      getConnections: () => [],
      dial: () => {
        dials += 1;
        return Promise.resolve({});
      },
      peerStore: { merge: () => Promise.resolve() },
      addEventListener: (type, listener) => {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type)?.add(listener);
      },
      removeEventListener: (type, listener) => { listeners.get(type)?.delete(listener); },
    };
    const { lines, logger } = capturingLogger();

    const stop = dialBootstraps(fake, [`/ip4/192.168.1.139/tcp/4001/tls/ws/p2p/${atlasPeerId}`], logger, { initialDelayMs: 10, maxDelayMs: 20 });
    await until(() => (listeners.get("peer:disconnect")?.size ?? 0) === 1);
    emit("peer:disconnect", "otro-peer");
    expect(dials).toBe(1);
    emit("peer:disconnect", atlasPeerId);
    await until(() => lines.some((line) => line.startsWith("info bootstrap reconectado")));

    expect(dials).toBe(2);
    expect(lines).toContain(`warn se perdió la conexión con el bootstrap (/ip4/192.168.1.139/tcp/4001/tls/ws/p2p/${atlasPeerId}); reintentando`);
    await until(() => (listeners.get("peer:disconnect")?.size ?? 0) === 1);
    stop();
    expect(listeners.get("peer:disconnect")?.size).toBe(0);
  });

  it("stops retrying when asked", async () => {
    const fake: DiagNode = {
      peerId: { toString: () => "self" },
      getMultiaddrs: () => [],
      getPeers: () => [],
      getConnections: () => [],
      dial: () => Promise.reject(new Error("connect ECONNREFUSED")),
      peerStore: { merge: () => Promise.resolve() },
      addEventListener: () => {},
    };
    const { lines, logger } = capturingLogger();

    const stop = dialBootstraps(fake, ["/ip4/192.168.1.139/tcp/4001/tls/ws/p2p/12D3KooWJNDdrDDeJS15GyrEyqzuXzdZF5f1UXKTQGZEHPfrVdsi"], logger, { initialDelayMs: 30, maxDelayMs: 30 });
    await until(() => lines.length >= 1);
    stop();
    const count = lines.length;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(lines.length).toBe(count);
  });

  it("reports an invalid bootstrap address instead of throwing", async () => {
    const client = await makeNode("diag-client-invalid");
    await client.start();
    const { lines, logger } = capturingLogger();
    dialBootstraps(client, ["esto-no-es-una-multiaddr"], logger);
    await until(() => lines.length === 1);
    expect(lines[0]).toContain("bootstrap inválido");
  });
});

describe("nodeStatus", () => {
  it("lists connections with their remote address", async () => {
    const atlas = await makeNode("diag-status-atlas");
    const client = await makeNode("diag-status-client");
    await atlas.start();
    await client.start();
    const { logger } = capturingLogger();
    dialBootstraps(client, [`/memory/diag-status-atlas/p2p/${atlas.peerId.toString()}`], logger);
    await until(() => client.getConnections().length > 0);

    const status = nodeStatus(client);
    expect(status.peerId).toBe(client.peerId.toString());
    expect(status.peerCount).toBe(1);
    expect(status.connections[0].peer).toBe(atlas.peerId.toString());
    expect(status.connections[0].remoteAddr).toContain("/memory/diag-status-atlas");
    expect(status.connections[0].direction).toBe("outbound");
  });
});

describe("errorMessage", () => {
  it("keeps the system error code and flattens AggregateError", () => {
    const refused = Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" });
    expect(errorMessage(refused)).toBe("connect failed (ECONNREFUSED)");
    expect(errorMessage(new AggregateError([refused, new TypeError("x")], "All multiaddr dials failed")))
      .toBe("All multiaddr dials failed: connect failed (ECONNREFUSED); TypeError: x");
  });
});
