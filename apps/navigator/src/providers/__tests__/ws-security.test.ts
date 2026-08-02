import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

describe("clampTimeoutMs (CodeQL js/resource-exhaustion)", () => {
  it("usa el fallback si no viene timeoutMs", async () => {
    const { clampTimeoutMs } = await import("../ws-security.js");
    expect(clampTimeoutMs(undefined, 5000)).toBe(5000);
  });

  it("usa el fallback ante valores no finitos (NaN/Infinity)", async () => {
    const { clampTimeoutMs } = await import("../ws-security.js");
    expect(clampTimeoutMs(NaN, 5000)).toBe(5000);
    expect(clampTimeoutMs(Infinity, 5000)).toBe(5000);
  });

  it("acota por debajo al mínimo (evita 0/negativos disparando el timer de inmediato)", async () => {
    const { clampTimeoutMs } = await import("../ws-security.js");
    expect(clampTimeoutMs(-1000, 5000)).toBe(1000);
    expect(clampTimeoutMs(0, 5000)).toBe(1000);
  });

  it("acota por arriba al máximo (evita que el cliente pida un timer casi infinito)", async () => {
    const { clampTimeoutMs } = await import("../ws-security.js");
    expect(clampTimeoutMs(10_000_000, 5000)).toBe(600_000);
  });

  it("respeta valores dentro del rango", async () => {
    const { clampTimeoutMs } = await import("../ws-security.js");
    expect(clampTimeoutMs(15_000, 5000)).toBe(15_000);
  });
});

describe("wsOptions (CodeQL js/disabling-certificate-validation)", () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    delete process.env.TLS_CA_CERT_PATH;
    delete process.env.FHS_TLS_INSECURE;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("no aplica nada a URLs ws:// (no TLS)", async () => {
    const { wsOptions } = await import("../ws-security.js");
    expect(wsOptions("ws://localhost:1234")).toBeUndefined();
  });

  it("por defecto (sin TLS_CA_CERT_PATH ni FHS_TLS_INSECURE), no desactiva la verificación", async () => {
    const { wsOptions } = await import("../ws-security.js");
    // Antes de este fix, esto retornaba { rejectUnauthorized: false }
    // incondicionalmente para toda wss:// — ahora el default es seguro.
    expect(wsOptions("wss://localhost:1234")).toBeUndefined();
  });

  it("con FHS_TLS_INSECURE=true, cae al modo inseguro explícito (opt-in)", async () => {
    process.env.FHS_TLS_INSECURE = "true";
    const { wsOptions } = await import("../ws-security.js");
    expect(wsOptions("wss://localhost:1234")).toEqual({ rejectUnauthorized: false });
  });
});
