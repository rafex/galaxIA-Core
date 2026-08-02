import { describe, it, expect, vi } from "vitest";
import { connectNatsBridge } from "../nats-bridge.js";
import { EventBus } from "../sse/event-bus.js";

describe("connectNatsBridge (DEC-0074)", () => {
  it("sin NATS_URL, degrada a no-op sin intentar conectar", async () => {
    const warn = vi.fn();
    const consumer = await connectNatsBridge(undefined, new EventBus(), { warn });
    expect(warn).not.toHaveBeenCalled();
    expect(consumer.connected).toBe(false);
    await expect(consumer.close()).resolves.toBeUndefined();
  });

  it("si la conexión a NATS falla, degrada a no-op con warning y connected=false (el chat sigue funcionando sin esto)", async () => {
    const warn = vi.fn();
    const consumer = await connectNatsBridge("nats://127.0.0.1:4", new EventBus(), { warn });
    expect(warn).toHaveBeenCalledOnce();
    expect(consumer.connected).toBe(false);
    await expect(consumer.close()).resolves.toBeUndefined();
  });
});
