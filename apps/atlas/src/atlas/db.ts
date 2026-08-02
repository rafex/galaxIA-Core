import type {
  Signal,
  ModelInfo,
  PublishedService,
  NodeType,
  RegisteredNode,
} from "@rafex/galaxia-fhs-protocol";

export interface AtlasStore {
  upsertNode(node: {
    providerId: string;
    name: string;
    lastSeen: number;
    leaseExpires: number;
    registeredAt: number;
    updatedAt: number;
    status?: string;
  }): void;
  updateNodeStatus(providerId: string, status: string, updatedAt: number): void;
  getOnlineNodes(): RegisteredNode[];
  getNode(providerId: string): RegisteredNode | undefined;
  replaceServices(
    providerId: string,
    services: Array<{
      id?: string;
      kind: NodeType;
      endpoint: { url: string; protocol: string; transport?: string };
      capabilities: Signal[];
      models?: ModelInfo[];
      visibility?: PublishedService["visibility"];
      status?: string;
    }>,
    timestamp: number
  ): void;
  getExpiredNodes(now: number): Array<{ provider_id: string; name: string }>;
}

export class MemoryAtlasStore implements AtlasStore {
  private nodes = new Map<string, RegisteredNode>();

  upsertNode(node: {
    providerId: string;
    name: string;
    lastSeen: number;
    leaseExpires: number;
    registeredAt: number;
    updatedAt: number;
    status?: string;
  }): void {
    const existing = this.nodes.get(node.providerId);
    this.nodes.set(node.providerId, {
      providerId: node.providerId,
      name: node.name,
      status: (node.status as RegisteredNode["status"]) || "online",
      lastSeen: node.lastSeen,
      leaseExpires: node.leaseExpires,
      registeredAt: existing ? existing.registeredAt : node.registeredAt,
      services: existing ? existing.services : [],
    });
  }

  updateNodeStatus(providerId: string, status: string, _updatedAt: number): void {
    const node = this.nodes.get(providerId);
    if (node) {
      node.status = status as RegisteredNode["status"];
    }
  }

  getOnlineNodes(): RegisteredNode[] {
    return Array.from(this.nodes.values()).filter((n) => n.status === "online");
  }

  getNode(providerId: string): RegisteredNode | undefined {
    return this.nodes.get(providerId);
  }

  replaceServices(
    providerId: string,
    services: Array<{
      id?: string;
      kind: NodeType;
      endpoint: { url: string; protocol: string; transport?: string };
      capabilities: Signal[];
      models?: ModelInfo[];
      visibility?: PublishedService["visibility"];
      status?: string;
    }>,
    timestamp: number
  ): void {
    const node = this.nodes.get(providerId);
    if (!node) return;

    node.services = services.map((svc) => ({
      id: svc.id || randomId(),
      nodeId: providerId,
      kind: svc.kind,
      endpoint: svc.endpoint as PublishedService["endpoint"],
      capabilities: svc.capabilities,
      status: (svc.status || "available") as PublishedService["status"],
      models: svc.models,
      visibility: svc.visibility,
      updatedAt: timestamp,
    }));
  }

  getExpiredNodes(now: number): Array<{ provider_id: string; name: string }> {
    const result: Array<{ provider_id: string; name: string }> = [];
    for (const node of this.nodes.values()) {
      if (node.status === "online" && node.leaseExpires < now) {
        result.push({ provider_id: node.providerId, name: node.name });
      }
    }
    return result;
  }
}

function randomId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
