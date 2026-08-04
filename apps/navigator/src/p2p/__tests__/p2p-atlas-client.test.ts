import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { FhsProto } from "@rafex/galaxia-fhs-protocol";
import { P2pAtlasClient } from "../p2p-atlas-client.js";
import { PeerCache } from "../nav-node.js";

describe("P2pAtlasClient", () => {
  it("propaga la visibilidad community del beacon al servicio LLM", async () => {
    const cache = new PeerCache();
    cache.upsert(create(FhsProto.NodeAdvertiseMessageSchema, {
      did: "did:key:star",
      beacon: create(FhsProto.BeaconSchema, {
        provider: create(FhsProto.ProviderIdentitySchema, {
          id: "did:key:star",
          type: FhsProto.ProviderType.STAR,
          visibility: FhsProto.Visibility.COMMUNITY,
          name: "Star",
        }),
        capabilities: [create(FhsProto.CapabilityDescriptorSchema, { id: "chat" })],
      }),
      multiaddrs: [],
      timestamp: BigInt(Date.now()),
      ttlSeconds: 60,
      trustLevel: "community",
    }));

    const [provider] = await new P2pAtlasClient(cache).getProviders("llm");

    expect(provider?.service.visibility).toBe("community");
    expect(provider?.service.models?.[0]?.toolCalling?.supported).toBe(true);
  });
});
