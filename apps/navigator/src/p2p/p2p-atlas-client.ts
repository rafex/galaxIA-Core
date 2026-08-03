/* eslint-disable @typescript-eslint/require-await */
/**
 * AtlasClient P2P (DEC-0088).
 * Implementa la misma interfaz que AtlasClient pero usando PeerCache
 * en lugar de HTTP al Atlas centralizado.
 *
 * getProviders("llm") → stars del peer-cache
 * getProviders("mcp") → satellites del peer-cache
 * recordSample() → no-op (la telemetría P2P se hará via ReputationUpdate FloodSub)
 */

import type { PublishedService } from "@rafex/galaxia-fhs-protocol";
import type { ResolvedProvider } from "../atlas-client.js";
import type { PeerCache, PeerEntry } from "./nav-node.js";

function peerToProvider(peer: PeerEntry, type: "llm" | "mcp"): ResolvedProvider {
  const service: PublishedService = {
    endpoint: { url: `p2p://${peer.did}` },
    capabilities: peer.capabilities.map((id) => ({ id, type })),
    models:
      type === "llm"
        ? [
            {
              id: "auto",
              displayName: "Auto (P2P)",
              name: "Auto (P2P)",
              capabilities: ["tool.calling"],
              toolCalling: { supported: true },
            },
          ]
        : [],
    privacy: { scope: "network" },
  } as unknown as PublishedService;

  return {
    providerId: peer.did,
    name: peer.did,
    type,
    service,
  };
}

export class P2pAtlasClient {
  constructor(private readonly peerCache: PeerCache) {}

  async getProviders(type?: "llm" | "mcp"): Promise<ResolvedProvider[]> {
    const peers =
      type === "llm"
        ? this.peerCache.getStars()
        : type === "mcp"
          ? this.peerCache.getSatellites()
          : this.peerCache.all();

    return peers.map((p) =>
      peerToProvider(p, type === "llm" ? "llm" : "mcp")
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  recordSample(_input: unknown): void {
    // No-op en P2P; telemetría via ReputationUpdate (pendiente DEC-0088)
  }
}
