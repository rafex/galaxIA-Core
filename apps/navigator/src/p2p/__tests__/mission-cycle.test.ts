import { describe, expect, it } from "vitest";
import { selectWinningBid } from "../mission-cycle.js";

const bid = (providerDid: string, trustLevel: string, reputationScore = 0.5, estimatedLatencyMs = 100) =>
  ({ providerDid, trustLevel, reputationScore, estimatedLatencyMs });

describe("selectWinningBid", () => {
  it("gana el proveedor preferido si pujó, aunque otro tenga mejor rango", () => {
    const bids = [bid("did:star:a", "standard"), bid("did:star:b", "community")];
    expect(selectWinningBid(bids, "did:star:b").providerDid).toBe("did:star:b");
  });

  it("si el preferido no pujó, gana el mejor por trust → reputación → latencia", () => {
    const bids = [
      bid("did:star:a", "community", 0.9, 50),
      bid("did:star:b", "standard", 0.1, 900),
      bid("did:star:c", "standard", 0.1, 100),
    ];
    expect(selectWinningBid(bids, "did:star:ausente").providerDid).toBe("did:star:c");
  });

  it("no reordena el arreglo recibido", () => {
    const bids = [bid("did:star:a", "community"), bid("did:star:b", "standard")];
    selectWinningBid(bids);
    expect(bids.map((b) => b.providerDid)).toEqual(["did:star:a", "did:star:b"]);
  });
});
