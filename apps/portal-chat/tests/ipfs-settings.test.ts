import { describe, expect, it } from "vitest";
import { ipfsGateway, ipfsPreference, IPFS_PRIVACY_WARNING } from "../src/services/ipfs-settings.js";

const choice = { ipfsEnabled: true, ipfsNetwork: "public" as const, ipfsRetention: "ephemeral" as const };

describe("preferencia IPFS del Portal (DEC-0095)", () => {
  it("sin la variable de build no hay IPFS: la petición va directa", () => {
    expect(ipfsGateway(undefined)).toBeNull();
    expect(ipfsGateway("  ")).toBeNull();
    expect(ipfsPreference(choice, ipfsGateway(undefined))).toBeUndefined();
  });

  it("con gateway y red pública viaja la preferencia", () => {
    const gateway = ipfsGateway("https://ipfs.io/ipfs");
    expect(ipfsPreference(choice, gateway)).toEqual({ enabled: true, network: "public", retention: "ephemeral" });
    expect(ipfsPreference({ ...choice, ipfsRetention: "reuse" }, gateway)?.retention).toBe("reuse");
    expect(ipfsPreference({ ...choice, ipfsEnabled: false }, gateway)).toBeUndefined();
  });

  it("la red privada aún no está disponible", () => {
    expect(ipfsPreference({ ...choice, ipfsNetwork: "private" }, "https://ipfs.io/ipfs")).toBeUndefined();
  });

  it("el aviso dice sin eufemismos que el archivo queda público", () => {
    expect(IPFS_PRIVACY_WARNING).toContain("cualquiera que conozca su identificador");
    expect(IPFS_PRIVACY_WARNING).toContain("no sensibles");
  });
});
