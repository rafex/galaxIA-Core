/* eslint-disable @typescript-eslint/require-await */
/**
 * AtlasClient P2P (DEC-0088).
 * Implementa la misma interfaz que AtlasClient pero usando PeerCache
 * en lugar de HTTP al Atlas centralizado.
 *
 * getProviders("llm") → stars del peer-cache
 * getProviders("mcp") → satellites del peer-cache
 * recordSample() → no-op (la telemetría P2P se hará via ReputationUpdate GossipSub)
 */

import { FhsProto, type PublishedService } from "@rafex/galaxia-fhs-protocol";
import type { AtlasClient, ResolvedProvider } from "../atlas-client.js";
import type { PeerCache, PeerEntry } from "./nav-node.js";

function peerToProvider(peer: PeerEntry, type: "llm" | "mcp"): ResolvedProvider {
  const identity = peer.beacon.provider;
  const service: PublishedService = {
    endpoint: { url: `p2p://${peer.did}`, protocol: "fhs" },
    // La descripción y las etiquetas del beacon firmado viajan con cada
    // capacidad. Antes solo se copiaba el id: la recomendación de KB
    // comparaba la pregunta contra "knowledge.query" y nunca recomendaba nada.
    capabilities: peer.capabilities.map((id) => ({
      id,
      type,
      description: peer.beacon.capabilities.find((capability) => capability.id === id)?.description
        || identity?.description
        || "",
      tags: identity?.tags ?? [],
    })),
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
    // Preserve the provider visibility declared in the signed FHS beacon.
    // Without this field matchesScope() treats the peer as external and
    // rejects community-scoped requests even when the beacon says community.
    visibility: visibilityFromBeacon(peer.beacon.provider?.visibility),
    privacy: { scope: "network" },
  } as unknown as PublishedService;

  return {
    providerId: peer.did,
    // Nombre legible del beacon ("Star FHS Bastion"); el DID sigue en providerId.
    name: identity?.name || peer.did,
    type,
    service,
  };
}

function visibilityFromBeacon(value: FhsProto.Visibility | undefined): "local" | "network" | "community" | "external" {
  switch (value) {
    case FhsProto.Visibility.PRIVATE:
      return "local";
    case FhsProto.Visibility.COMMUNITY:
      return "community";
    case FhsProto.Visibility.PUBLIC:
      return "external";
    default:
      // Reference providers default to community visibility. An unspecified
      // beacon must not silently become external and disappear from the MVP
      // community scope.
      return "community";
  }
}

export class P2pAtlasClient implements AtlasClient {
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
