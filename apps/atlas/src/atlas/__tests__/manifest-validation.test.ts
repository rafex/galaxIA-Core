import { describe, it, expect } from "vitest";
import { validateManifest } from "../manifest-validation.js";

describe("validateManifest", () => {
  it("rechaza null", () => {
    expect(validateManifest(null)).toEqual({ valid: false, missing: ["manifest"] });
  });

  it("rechaza undefined", () => {
    expect(validateManifest(undefined)).toEqual({ valid: false, missing: ["manifest"] });
  });

  it("rechaza no-objeto", () => {
    expect(validateManifest("string").valid).toBe(false);
  });

  it("detecta campos obligatorios faltantes", () => {
    const result = validateManifest({});
    expect(result.valid).toBe(false);
    expect(result.missing).toContain("fhsVersion");
    expect(result.missing).toContain("provider.id");
    expect(result.missing).toContain("provider.type");
    expect(result.missing).toContain("provider.visibility");
    expect(result.missing).toContain("privacy.retention");
    expect(result.missing).toContain("endpoint");
  });

  it("acepta manifiesto completo tipo llm", () => {
    const manifest = {
      fhsVersion: "0.1",
      provider: { id: "did:key:test", type: "llm", name: "Test", visibility: "community" },
      privacy: { retention: "none", trainingUse: false },
      endpoint: { url: "ws://localhost:1234", protocol: "fhs/v1" },
    };
    expect(validateManifest(manifest)).toEqual({ valid: true, missing: [] });
  });

  it("rechaza llm sin privacy.trainingUse", () => {
    const manifest = {
      fhsVersion: "0.1",
      provider: { id: "did:key:test", type: "llm", name: "Test", visibility: "community" },
      privacy: { retention: "none" },
      endpoint: { url: "ws://localhost:1234", protocol: "fhs/v1" },
    };
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.missing).toContain("privacy.trainingUse");
  });

  it("no requiere endpoint en multi (usa services)", () => {
    const manifest = {
      fhsVersion: "0.1",
      provider: { id: "did:key:test", type: "multi", name: "Test", visibility: "community" },
      privacy: { retention: "none" },
      services: [{ endpoint: { url: "ws://localhost:1234", protocol: "fhs/v1" } }],
    };
    const result = validateManifest(manifest);
    expect(result.valid).toBe(true);
    expect(result.missing).toHaveLength(0);
  });

  it("rechaza multi sin services", () => {
    const manifest = {
      fhsVersion: "0.1",
      provider: { id: "did:key:test", type: "multi", name: "Test", visibility: "community" },
      privacy: { retention: "none" },
    };
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.missing).toContain("services");
  });

  it("rechaza multi con array services vacío", () => {
    const manifest = {
      fhsVersion: "0.1",
      provider: { id: "did:key:test", type: "multi", name: "Test", visibility: "community" },
      privacy: { retention: "none" },
      services: [],
    };
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.missing).toContain("services");
  });

  it("rechaza multi con service sin endpoint", () => {
    const manifest = {
      fhsVersion: "0.1",
      provider: { id: "did:key:test", type: "multi", name: "Test", visibility: "community" },
      privacy: { retention: "none" },
      services: [{}],
    };
    const result = validateManifest(manifest);
    expect(result.valid).toBe(false);
    expect(result.missing).toContain("services[0].endpoint");
  });
});
