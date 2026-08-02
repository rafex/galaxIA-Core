import { describe, it, expect, beforeEach } from "vitest";
import { McpHost, type LoadedTool } from "../mcp-host.js";

describe("McpHost", () => {
  let host: McpHost;

  beforeEach(() => {
    host = new McpHost();
  });

  describe("disconnect", () => {
    it("no falla con providerId desconocido", () => {
      expect(() => host.disconnect("desconocido")).not.toThrow();
    });
  });

  describe("callTool", () => {
    it("lanza error si el provider no está conectado", async () => {
      await expect(
        host.callTool("desconocido", "test.tool", { input: "test" })
      ).rejects.toThrow("FHS tool provider no conectado");
    });
  });

  describe("connectProvider", () => {
    it("lanza error si la conexión falla", async () => {
      await expect(
        host.connectProvider("bad-provider", "Bad", {
          id: "svc-1",
          nodeId: "bad-provider",
          kind: "mcp" as const,
          endpoint: { url: "ws://localhost:19999/invalid", protocol: "fhs" as const },
          capabilities: [{ id: "test.cap", description: "test" }],
          status: "available",
          updatedAt: Date.now(),
        })
      ).rejects.toThrow();
    });
  });

  describe("loadToolsForCapabilities", () => {
    it("retorna array vacío sin providers", async () => {
      const tools = await host.loadToolsForCapabilities([]);
      expect(tools).toEqual([]);
    });

    it("maneja gracefully providers que no conectan", async () => {
      const tools = await host.loadToolsForCapabilities([
        {
          providerId: "bad-1",
          providerName: "Bad",
          service: {
            id: "svc-1",
            nodeId: "bad-1",
            kind: "mcp" as const,
            endpoint: { url: "ws://localhost:19999/invalid", protocol: "fhs" as const },
            capabilities: [{ id: "test.cap", description: "test" }],
            status: "available",
            updatedAt: Date.now(),
          },
        },
      ]);
      expect(tools).toEqual([]);
    });
  });

  describe("LoadedTool type", () => {
    it("acepta schema como Record<string, unknown>", () => {
      const tool: LoadedTool = {
        name: "weather",
        description: "Obtiene el clima",
        inputSchema: { type: "object", properties: { city: { type: "string" } } },
        providerId: "did:key:test",
        providerName: "Test Provider",
        capabilityId: "weather.get",
      };
      expect(tool.inputSchema).toEqual({ type: "object", properties: { city: { type: "string" } } });
    });
  });
});
