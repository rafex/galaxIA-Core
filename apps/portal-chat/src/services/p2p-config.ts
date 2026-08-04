import { CODE_P2P, multiaddr } from "@multiformats/multiaddr";
import { WebSocketsSecure } from "@multiformats/multiaddr-matcher";

/**
 * A bootstrap address is only a way to enter the libp2p swarm.  The remote
 * peer identity is learned and authenticated by libp2p/FHS after dialing; it
 * must not be copied into the portal build as a fragile literal.
 */
export const NAVIGATOR_BOOTSTRAP_STORAGE_KEY = "fhs.navigator.bootstrap-addrs";

const TRAILING_P2P_COMPONENT = /\/p2p\/[^/]+$/;

export function normalizeNavigatorBootstrapAddress(rawAddress: string): string {
  const candidate = rawAddress.trim().replace(TRAILING_P2P_COMPONENT, "");
  if (!candidate) {
    throw new Error("La dirección de bootstrap está vacía");
  }

  const address = multiaddr(candidate);
  if (!WebSocketsSecure.matches(address)) {
    throw new Error("El bootstrap del portal debe usar una multiaddr TLS WebSocket (/tls/ws)");
  }

  // A configured /p2p/<peerId> is intentionally ignored.  This prevents a
  // stale or mistyped peer id from turning a valid transport address into a
  // connection failure.  Noise + the signed FHS handshake authenticate the
  // peer once the stream is established.
  return address.decapsulateCode(CODE_P2P).toString();
}

export function parseNavigatorBootstrapAddresses(rawValues: Array<string | undefined>): string[] {
  const addresses = new Set<string>();
  for (const rawValue of rawValues) {
    for (const rawAddress of (rawValue ?? "").split(/[\n,]+/)) {
      if (!rawAddress.trim()) continue;
      addresses.add(normalizeNavigatorBootstrapAddress(rawAddress));
    }
  }
  return [...addresses];
}

export function resolveNavigatorBootstrapAddresses(
  envValues: Array<string | undefined>,
  storage?: Pick<Storage, "getItem">,
): string[] {
  const storedValue = storage?.getItem(NAVIGATOR_BOOTSTRAP_STORAGE_KEY) ?? undefined;
  return parseNavigatorBootstrapAddresses([...envValues, storedValue]);
}

export async function loadNavigatorBootstrapAddresses(
  envValues: Array<string | undefined>,
  storage: Pick<Storage, "getItem"> | undefined,
  fetcher: typeof fetch = fetch,
): Promise<string[]> {
  let runtimeValue: string | undefined;
  let response: Response | undefined;
  try {
    response = await fetcher(`/p2p-config.json?ts=${Date.now()}`, { cache: "no-store" });
  } catch {
    // Vite development and an already-running static server may not have the
    // runtime file. In that case the explicit environment/storage sources are
    // still valid bootstrap configuration.
  }

  if (response?.ok) {
    let config: { navigatorBootstrapAddrs?: unknown };
    try {
      config = (await response.json()) as { navigatorBootstrapAddrs?: unknown };
    } catch {
      throw new Error("p2p-config.json no contiene JSON válido");
    }
    if (config.navigatorBootstrapAddrs !== undefined && typeof config.navigatorBootstrapAddrs !== "string") {
      throw new Error("p2p-config.json.navigatorBootstrapAddrs debe ser texto");
    }
    runtimeValue = config.navigatorBootstrapAddrs;
  }

  return resolveNavigatorBootstrapAddresses([runtimeValue, ...envValues], storage);
}
