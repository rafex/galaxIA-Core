import type { FastifyInstance } from "fastify";
import { Atlas } from "../atlas/registry.js";

interface ModelListEntry {
  modelId: string;
  displayName: string;
  providerId: string;
  providerName: string;
  capabilities: string[];
  contextWindow?: number;
  /** DEC-0031: true si el nodo está en FHS_TRUSTED_PROVIDERS del operador. */
  trusted: boolean;
}

export function setupProvidersApi(app: FastifyInstance, registry: Atlas) {
  app.get("/api/fhs/nodes", () => {
    return registry.getNodes();
  });

  app.get("/api/fhs/providers", (req) => {
    const type = (req.query as { type?: "llm" | "mcp" }).type;
    const providers = registry.getProviders(type);
    // SPEC-SATRATING-0001: adjunta fiabilidad/rating por capability — por
    // modelo si es tipo "llm", por capability declarada si es tipo "mcp".
    // null si nunca se registró una muestra (nodo recién conectado).
    return providers.map((p) => {
      const capabilityIds =
        p.type === "llm"
          ? (p.service.models || []).map((m) => m.id)
          : (p.service.capabilities || []).map((c) => c.id);
      const metrics = capabilityIds.map((capability) => ({
        capability,
        ...registry.getMetrics(p.providerId, capability),
      }));
      return { ...p, metrics };
    });
  });

  app.get("/api/fhs/models", () => {
    const providers = registry.getProviders("llm");
    const models: ModelListEntry[] = [];
    for (const p of providers) {
      for (const m of p.service.models || []) {
        models.push({
          modelId: m.id,
          displayName: m.displayName,
          providerId: p.providerId,
          providerName: p.name,
          capabilities: m.capabilities,
          contextWindow: m.contextWindow,
          trusted: p.trusted,
        });
      }
    }
    return { models };
  });

  app.get("/api/fhs/capabilities", () => {
    const providers = registry.getProviders("mcp");
    const caps = new Set<string>();
    for (const p of providers) {
      for (const c of p.service.capabilities || []) {
        caps.add(c.id);
      }
    }
    return { capabilities: Array.from(caps) };
  });

  app.post("/api/fhs/resolve", (req) => {
    const { kind, capabilities: _capabilities, scope: _scope } = req.body as {
      kind: "llm" | "mcp";
      capabilities?: string[];
      scope?: string;
    };
    const candidates = registry.getProviders(kind);
    // Por ahora devuelve el primero disponible. El selector más sofisticado irá en el runtime.
    const selected = candidates[0];
    return {
      kind,
      selected: selected
        ? {
            providerId: selected.providerId,
            providerName: selected.name,
            serviceId: selected.service.id,
            capabilities: selected.service.capabilities.map((c) => c.id),
          }
        : null,
      reason: selected ? ["available"] : ["none"],
    };
  });
}
