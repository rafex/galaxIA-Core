import { describe, it, expect, beforeEach } from "vitest";
import { EventBus } from "../../sse/event-bus.js";
import { Atlas, type WebSocketLike } from "../registry.js";

function stubSocket(open = true): WebSocketLike & { sent: string[] } {
  const sent: string[] = [];
  return {
    send(data: string) { sent.push(data); },
    close() {},
    readyState: open ? 1 : 3,
    sent,
  };
}

function stubEventBus() {
  const events: unknown[] = [];
  const bus = new EventBus();
  bus.subscribeToRuntime((event) => events.push(event));
  return { bus, events };
}

describe("Atlas", () => {
  let atlas: Atlas;
  let events: unknown[];
  let bus: EventBus;

  beforeEach(() => {
    const eb = stubEventBus();
    bus = eb.bus;
    events = eb.events;
    atlas = new Atlas(bus, ":memory:");
  });

  it("reporta versión del protocolo", () => {
    expect(atlas.version).toBe("0.1");
  });

  it("reporta lease seconds", () => {
    expect(atlas.leaseSeconds).toBe(30);
  });

  describe("hasActiveConnection", () => {
    it("retorna false sin conexiones", () => {
      expect(atlas.hasActiveConnection("node-1")).toBe(false);
    });

    it("retorna true tras registrar conexión", () => {
      const ws = stubSocket(true);
      atlas.registerConnection("node-1", ws);
      expect(atlas.hasActiveConnection("node-1")).toBe(true);
    });

    it("retorna false tras remover conexión", () => {
      const ws = stubSocket(true);
      atlas.registerConnection("node-1", ws);
      atlas.removeConnection("node-1");
      expect(atlas.hasActiveConnection("node-1")).toBe(false);
    });
  });

  describe("touchConnection", () => {
    it("actualiza lastPong sin error", () => {
      const ws = stubSocket(true);
      atlas.registerConnection("node-1", ws);
      expect(() => atlas.touchConnection("node-1")).not.toThrow();
    });

    it("no falla con id desconocido", () => {
      expect(() => atlas.touchConnection("desconocido")).not.toThrow();
    });
  });

  describe("registerOrUpdate", () => {
    const minimalManifest = {
      fhsVersion: "0.1",
      endpoint: { url: "ws://localhost:1234", protocol: "fhs" as const },
      provider: { id: "did:key:test", name: "Test Node", type: "llm" as const, visibility: "community" as const },
      privacy: { retention: "none" as const, trainingUse: false },
      models: [{ id: "llama3", displayName: "Llama 3", capabilities: ["chat"] }],
    };

    beforeEach(() => {
      const ws = stubSocket(true);
      atlas.registerConnection("did:key:test", ws);
    });

    it("registra un proveedor y emite evento node.online", () => {
      const count = atlas.registerOrUpdate("did:key:test", minimalManifest);
      expect(count).toBeGreaterThan(0);
      expect(events.length).toBe(1);
      expect(events[0]).toMatchObject({ type: "node.online" as const });
    });

    it("getProviders retorna el proveedor registrado", () => {
      atlas.registerOrUpdate("did:key:test", minimalManifest);
      const providers = atlas.getProviders("llm");
      expect(providers).toHaveLength(1);
      expect(providers[0].providerId).toBe("did:key:test");
      expect(providers[0].name).toBe("Test Node");
    });

    it("getProviders filtra por tipo mcp (no encuentra llm)", () => {
      atlas.registerOrUpdate("did:key:test", minimalManifest);
      expect(atlas.getProviders("mcp")).toHaveLength(0);
    });
  });

  describe("markLost", () => {
    it("emite evento node.lost", () => {
      const ws = stubSocket(true);
      atlas.registerConnection("did:key:test", ws);
      atlas.registerOrUpdate("did:key:test", {
        fhsVersion: "0.1",
        endpoint: { url: "ws://localhost:1234", protocol: "fhs" as const },
        provider: { id: "did:key:test", name: "Test", type: "llm" as const, visibility: "community" as const },
        privacy: { retention: "none" as const, trainingUse: false },
        models: [{ id: "llama3", displayName: "Llama 3", capabilities: ["chat"] }],
      });

      events.length = 0; // reset
      atlas.markLost("did:key:test");
      expect(events[0]).toMatchObject({ type: "node.lost" as const });
    });
  });

  describe("getProviders con filtro", () => {
    it("retorna todos los tipos sin filtro", () => {
      const ws = stubSocket(true);
      atlas.registerConnection("did:key:a", ws);
      atlas.registerOrUpdate("did:key:a", {
        fhsVersion: "0.1",
        endpoint: { url: "ws://localhost:1", protocol: "fhs" as const },
        provider: { id: "did:key:a", name: "A", type: "llm" as const, visibility: "community" as const },
        privacy: { retention: "none" as const, trainingUse: false },
        models: [{ id: "llama3", displayName: "Llama 3", capabilities: ["chat"] }],
      });
      expect(atlas.getProviders()).toHaveLength(1);
    });
  });
});
