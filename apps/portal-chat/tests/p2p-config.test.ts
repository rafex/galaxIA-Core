import { describe, expect, it } from "vitest";
import {
  normalizeNavigatorBootstrapAddress,
  parseNavigatorBootstrapAddresses,
  resolveNavigatorBootstrapAddresses,
  loadNavigatorBootstrapAddresses,
} from "../src/services/p2p-config.js";

const transportAddress = "/ip4/192.168.3.175/tcp/4010/tls/ws";

describe("portal bootstrap discovery", () => {
  it("removes an optional peer id from the bootstrap address", () => {
    expect(normalizeNavigatorBootstrapAddress(`${transportAddress}/p2p/not-a-peer-id`)).toBe(transportAddress);
  });

  it("accepts several bootstrap addresses and removes duplicates", () => {
    expect(parseNavigatorBootstrapAddresses([
      `${transportAddress}/p2p/stale-peer-id`,
      `${transportAddress}, /dns4/navigator.local/tcp/4010/tls/ws`,
    ])).toEqual([
      transportAddress,
      "/dns4/navigator.local/tcp/4010/tls/ws",
    ]);
  });

  it("rejects an unencrypted WebSocket bootstrap", () => {
    expect(() => normalizeNavigatorBootstrapAddress("/ip4/192.168.3.175/tcp/4010/ws")).toThrow(/TLS WebSocket/);
  });

  it("uses browser storage as a runtime bootstrap source", () => {
    const storage = { getItem: () => `${transportAddress}/p2p/rotated-peer-id` };
    expect(resolveNavigatorBootstrapAddresses([], storage)).toEqual([transportAddress]);
  });

  it("loads runtime bootstrap without rebuilding the frontend", async () => {
    const fetcher = async () => new Response(JSON.stringify({ navigatorBootstrapAddrs: `${transportAddress}/p2p/rotated-peer-id` }), { status: 200 });
    await expect(loadNavigatorBootstrapAddresses([], undefined, fetcher)).resolves.toEqual([transportAddress]);
  });
});
