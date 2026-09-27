import { describe, expect, it } from "vitest";
import { dialProvider, type ProviderDialer } from "../nav-node.js";

const OCR = "did:key:z6MkguPnBeakGPZtW9YKJ8CcZNvuoxoju9Za8S7kwzAv2osH";
const PEER = "/p2p/12D3KooWCGVuLXv27kLuoYD3F9z7V5TkUiaXWxPhQ1ZrVhMo1Xoq";

/** Nodo simulado: solo "llegan" las direcciones de `reachable`. */
function fakeNode(reachable: string[], fail: (address: string) => unknown = () => new Error("ECONNREFUSED")) {
  const dialed: string[] = [];
  const node: ProviderDialer = {
    dial: (address: unknown) => {
      const value = String(address);
      dialed.push(value);
      if (reachable.includes(value)) return Promise.resolve({ remoteAddr: value });
      // El cliente WebSocket de Node rechaza con un ErrorEvent, no con un Error:
      // justo lo que dialProvider debe saber describir.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject(fail(value));
    },
  };
  return { node, dialed };
}

describe("dialProvider", () => {
  it("prueba primero las direcciones de red y deja loopback al final (E2E-027)", async () => {
    // El OCR de la Raspi4B anuncia 127.0.0.1 primero; desde Bastion eso es Bastion.
    const lan = `/ip4/192.168.1.167/tcp/4003/tls/ws${PEER}`;
    const { node, dialed } = fakeNode([lan]);

    const conn = await dialProvider<{ remoteAddr: string }>(node, OCR, [
      `/ip4/127.0.0.1/tcp/4003/tls/ws${PEER}`,
      lan,
    ]);

    expect(conn.remoteAddr).toBe(lan);
    expect(dialed).toEqual([lan]);
  });

  it("sigue con la siguiente dirección si una falla", async () => {
    const good = `/ip4/192.168.1.167/tcp/4003/tls/ws${PEER}`;
    const { node, dialed } = fakeNode([good]);

    await dialProvider(node, OCR, [`/ip4/192.168.3.202/tcp/4003/tls/ws${PEER}`, good]);

    expect(dialed).toHaveLength(2);
  });

  it("usa loopback si es la única que responde (provider en el mismo host)", async () => {
    const loopback = `/ip4/127.0.0.1/tcp/4002/tls/ws${PEER}`;
    const { node } = fakeNode([loopback]);

    await expect(dialProvider(node, OCR, [loopback, `/ip4/192.168.3.175/tcp/4002/tls/ws${PEER}`])).resolves.toBeDefined();
  });

  it("si nada responde, dice qué falló en cada dirección sin [object ErrorEvent]", async () => {
    const errorEvent = (address: string) => ({
      type: "error",
      message: "",
      error: new Error("connect ECONNREFUSED"),
      target: { url: address },
    });
    const { node } = fakeNode([], errorEvent);

    const error = (await dialProvider(node, OCR, [
      `/ip4/127.0.0.1/tcp/4003/tls/ws${PEER}`,
      `/ip4/192.168.1.167/tcp/4003/tls/ws${PEER}`,
    ]).catch((reason: unknown) => reason)) as Error;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain(`no se pudo conectar con ${OCR}`);
    expect(error.message).toContain("192.168.1.167");
    expect(error.message).toContain("ECONNREFUSED");
    expect(error.message).not.toContain("[object");
  });

  it("falla claro si el provider no anunció direcciones", async () => {
    const { node } = fakeNode([]);
    await expect(dialProvider(node, OCR, [])).rejects.toThrow("no anunció multiaddrs");
  });
});
