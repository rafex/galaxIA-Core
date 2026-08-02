import { EventBus } from "../sse/event-bus.js";
import { MemoryAtlasStore, type AtlasStore } from "./db.js";
import { NodeMetricsStore, type LatencySample, type NodeMetricsSummary } from "./metrics.js";
import {
  DEFAULT_LEASE_SECONDS,
  HEARTBEAT_INTERVAL_SECONDS,
  LEASE_EXPIRE_SECONDS,
  NODE_PURGE_SECONDS,
  FHS_VERSION,
  type Beacon,
  type NodeInfo,
  type PublishedService,
  type NodeStatus,
  flattenManifest,
} from "@rafex/galaxia-fhs-protocol";

// DEC-0031: lista de providerIds de confianza configurados por el operador
// del Agent Server. Separados por coma, ej. "did:key:zAAA,did:key:zBBB".
// Los nodos en esta lista reciben `trusted: true` en la respuesta de
// /api/fhs/providers — el Portal puede mostrar un distintivo visual.
const TRUSTED_PROVIDER_IDS: ReadonlySet<string> = new Set(
  (process.env.FHS_TRUSTED_PROVIDERS ?? "").split(",").map((s) => s.trim()).filter(Boolean)
);

export interface AtlasConnection {
  providerId: string;
  socket: WebSocketLike;
  connectedAt: number;
  lastPong: number;
}

export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /** 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED (mismos valores que WebSocket estándar). */
  readyState?: number;
}

const WS_OPEN = 1;
const WS_CONNECTING = 0;

export class Atlas {
  private store: AtlasStore;
  private connections = new Map<string, AtlasConnection>();
  private checkTimer?: NodeJS.Timeout;
  private metrics: NodeMetricsStore;
  // DEC-0031: nodeInfo autodeclarado por cada proveedor en su manifiesto.
  private nodeInfos = new Map<string, NodeInfo | undefined>();

  constructor(private eventBus: EventBus, metricsDbPath: string) {
    this.store = new MemoryAtlasStore();
    this.metrics = new NodeMetricsStore(metricsDbPath);
  }

  /** SPEC-SATRATING-0001: historial de latencia/éxito por nodo + capability. */
  recordSample(providerId: string, capability: string, sample: LatencySample) {
    this.metrics.recordSample(providerId, capability, sample);
  }

  getMetrics(providerId: string, capability: string): NodeMetricsSummary | null {
    return this.metrics.getSummary(providerId, capability);
  }

  get version() {
    return FHS_VERSION;
  }

  get leaseSeconds() {
    return DEFAULT_LEASE_SECONDS;
  }

  /**
   * DEC-0009: si otra conexión ya está activa con este providerId, un
   * `hello` nuevo debe rechazarse en vez de sobrescribirla en silencio —
   * evita que un segundo nodo suplante la identidad de otro mientras el
   * DID siga sin firma criptográfica (DEC-0004). "Activa" se verifica por
   * el estado real del socket (no solo por estar en el mapa): si el
   * socket previo ya está CLOSING/CLOSED, se considera libre aunque el
   * `close` de esa conexión no se haya procesado todavía (ej. el proceso
   * remoto murió sin cerrar limpio). Si `readyState` no está disponible
   * (stub de pruebas), se asume activa por seguridad — mismo criterio
   * conservador que el resto de esta regla.
   */
  hasActiveConnection(providerId: string): boolean {
    const conn = this.connections.get(providerId);
    if (!conn) return false;
    const state = conn.socket.readyState;
    if (state === undefined) return true;
    return state === WS_OPEN || state === WS_CONNECTING;
  }

  registerConnection(providerId: string, socket: WebSocketLike) {
    const now = nowSeconds();
    this.connections.set(providerId, {
      providerId,
      socket,
      connectedAt: now,
      lastPong: now,
    });
  }

  removeConnection(providerId: string) {
    this.connections.delete(providerId);
  }

  touchConnection(providerId: string) {
    const conn = this.connections.get(providerId);
    if (conn) {
      conn.lastPong = nowSeconds();
    }
  }

  registerOrUpdate(providerId: string, manifest: Beacon) {
    const now = nowSeconds();
    const leaseExpires = now + LEASE_EXPIRE_SECONDS;

    this.nodeInfos.set(providerId, manifest.nodeInfo);

    this.store.upsertNode({
      providerId,
      name: manifest.provider.name,
      lastSeen: now,
      leaseExpires,
      registeredAt: now, // better-sqlite3 no actualiza created_at en upsert; mantenemos simple
      updatedAt: now,
    });

    const services: PublishedService[] = [];
    for (const entry of flattenManifest(manifest)) {
      services.push({
        id: cryptoRandomId(),
        nodeId: providerId,
        kind: entry.kind,
        endpoint: entry.endpoint,
        capabilities: entry.capabilities || [],
        models: entry.models,
        // Propaga el ámbito declarado por el nodo para que el Agent Server
        // pueda aplicar el scope de privacidad del usuario (regla 6).
        visibility: entry.provider.visibility,
        status: "available",
        updatedAt: now,
      });
    }

    this.store.replaceServices(providerId, services, now);

    this.eventBus.broadcastToRuntimes({
      type: "node.online",
      data: {
        providerId,
        providerName: manifest.provider.name,
        services: services.map((s) => ({
          kind: s.kind,
          capabilities: s.capabilities.map((c) => c.id),
        })),
      },
    });

    return services.length;
  }

  markLost(providerId: string) {
    this.nodeInfos.delete(providerId);
    this.store.updateNodeStatus(providerId, "lost", nowSeconds());
    const node = this.store.getNode(providerId);
    if (node) {
      this.eventBus.broadcastToRuntimes({
        type: "node.lost",
        data: {
          providerId,
          providerName: node.name,
          services: node.services.map((s) => ({
            kind: s.kind,
            capabilities: s.capabilities.map((c) => c.id),
          })),
        },
      });
    }
  }

  getNodes(status?: NodeStatus) {
    if (status) {
      // por simplicidad filtramos en memoria
      return this.store.getOnlineNodes().filter((n) => n.status === status);
    }
    return this.store.getOnlineNodes();
  }

  getProviders(type?: "llm" | "mcp") {
    const nodes = this.getNodes();
    const providers: Array<{
      providerId: string;
      name: string;
      type: string;
      service: PublishedService;
      /** DEC-0031: true si el providerId está en FHS_TRUSTED_PROVIDERS. */
      trusted: boolean;
      /** DEC-0031: metadatos de hardware/operador autodeclarados. */
      nodeInfo?: NodeInfo;
    }> = [];
    for (const node of nodes) {
      for (const service of node.services) {
        if (!type || service.kind === type) {
          providers.push({
            providerId: node.providerId,
            name: node.name,
            type: service.kind,
            service,
            trusted: TRUSTED_PROVIDER_IDS.has(node.providerId),
            nodeInfo: this.nodeInfos.get(node.providerId),
          });
        }
      }
    }
    return providers;
  }

  startHealthChecks() {
    if (this.checkTimer) return;
    this.checkTimer = setInterval(() => {
      const now = nowSeconds();
      const expired = this.store.getExpiredNodes(now);
      for (const node of expired) {
        this.markLost(node.provider_id);
      }

      // Limpiar nodos "lost" muy antiguos
      const nodes = this.store.getOnlineNodes();
      for (const node of nodes) {
        if (node.status === "lost" && now - node.leaseExpires > NODE_PURGE_SECONDS) {
          // Eliminar (la db no tiene DELETE aún; se puede agregar si es necesario)
        }
      }
    }, HEARTBEAT_INTERVAL_SECONDS * 1000);
  }

  stopHealthChecks() {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = undefined;
    }
  }
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function cryptoRandomId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
