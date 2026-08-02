import { describe, it, expect } from "vitest";
import { acquireInFlight, releaseInFlight, inFlightCount, atDeclaredCapacity } from "../inflight.js";

describe("inflight (DEC-0072)", () => {
  it("cuenta y libera por provider", () => {
    const id = "did:key:zTest1";
    expect(inFlightCount(id)).toBe(0);
    acquireInFlight(id);
    acquireInFlight(id);
    expect(inFlightCount(id)).toBe(2);
    releaseInFlight(id);
    expect(inFlightCount(id)).toBe(1);
    releaseInFlight(id);
    expect(inFlightCount(id)).toBe(0);
  });

  it("release de más no deja contadores negativos", () => {
    const id = "did:key:zTest2";
    releaseInFlight(id);
    expect(inFlightCount(id)).toBe(0);
  });

  it("atDeclaredCapacity respeta el cupo declarado y trata ausencia como sin límite", () => {
    const id = "did:key:zTest3";
    expect(atDeclaredCapacity(id, undefined)).toBe(false);
    expect(atDeclaredCapacity(id, 0)).toBe(false);
    acquireInFlight(id);
    expect(atDeclaredCapacity(id, 1)).toBe(true);
    expect(atDeclaredCapacity(id, 2)).toBe(false);
    releaseInFlight(id);
    expect(atDeclaredCapacity(id, 1)).toBe(false);
  });
});
