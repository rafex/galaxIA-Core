import { describe, it, expect, vi } from "vitest";
import { createNatsBridge } from "../nats-bridge.js";

describe("createNatsBridge (DEC-0074)", () => {
  it("sin NATS_URL, degrada a no-op sin intentar conectar", async () => {
    const warn = vi.fn();
    const bridge = await createNatsBridge(undefined, { warn });
    expect(warn).not.toHaveBeenCalled();
    expect(bridge.connected).toBe(false);
    expect(() => bridge.publish({ type: "node.online", data: {} } as never)).not.toThrow();
    await expect(bridge.close()).resolves.toBeUndefined();
  });

  it("si la conexión a NATS falla, degrada a no-op con warning y connected=false (nunca tumba a Atlas)", async () => {
    // Regresión (encontrado verificando el bridge de verdad, 2026-07-11): el
    // caller solo debe loggear "puente activo" si `connected` es true — antes
    // el log dependía solo de que NATS_URL estuviera seteado, mintiendo
    // "activo" incluso con la conexión rechazada.
    const warn = vi.fn();
    // Puerto que casi seguro no tiene un NATS real escuchando en CI/local.
    const bridge = await createNatsBridge("nats://127.0.0.1:4", { warn });
    expect(warn).toHaveBeenCalledOnce();
    expect(bridge.connected).toBe(false);
    expect(() => bridge.publish({ type: "node.lost", data: {} } as never)).not.toThrow();
  });
});
