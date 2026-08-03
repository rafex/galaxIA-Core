/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-floating-promises, @typescript-eslint/prefer-promise-reject-errors, @typescript-eslint/require-await */
/**
 * McpHost P2P (DEC-0088).
 * Reemplaza McpHost (WebSocket) por el ciclo P2P:
 *   offer (tool_call) → bid → assign → stream directo → handshake → tool_call → tool_result
 *
 * loadToolsForCapabilities() lee del beacon en PeerCache (sin pre-flight WS).
 * callTool() hace el ciclo completo de misión.
 */

import { randomUUID } from "node:crypto";
import { multiaddr } from "@multiformats/multiaddr";
import type { PublishedService } from "@rafex/galaxia-fhs-protocol";
import { McpHost, type LoadedTool, type DispatchResult, type TraceContext } from "../providers/mcp-host.js";
import { runMissionCycle } from "./mission-cycle.js";
import { sendEnvelope, decodeStream } from "./stream-codec.js";
import type { FhsNode, FhsIdentity, BidCollector, PeerCache } from "./nav-node.js";
import type {
  HandshakeAckMessage,
  ToolP2pCallResultMessage,
  ToolP2pCallErrorMessage,
} from "./fhs-p2p-types.js";
import { FHS_STREAM_PROTOCOL } from "./fhs-p2p-types.js";

const BID_DEADLINE_MS = 2_000;
const CALL_TIMEOUT_MS = 300_000;

export class P2pMcpHost extends McpHost {
  constructor(
    private readonly navNode: FhsNode,
    private readonly navIdentity: FhsIdentity,
    private readonly bidCollector: BidCollector,
    private readonly peerCache: PeerCache
  ) {
    super();
  }

  /**
   * Lee las tools disponibles directamente del beacon en PeerCache.
   * No abre streams — el beacon ya incluye la lista de tool names y capabilities.
   */
  override async loadToolsForCapabilities(
    providers: Array<{ providerId: string; providerName: string; service: PublishedService }>
  ): Promise<LoadedTool[]> {
    const tools: LoadedTool[] = [];

    for (const p of providers) {
      // Buscar en el peer-cache por DID (providerId)
      const peers = this.peerCache.all().filter((peer) => peer.did === p.providerId);
      if (peers.length === 0) continue;

      for (const peer of peers) {
        // Parsear beacon para obtener tools y capabilities
        try {
          const beacon = JSON.parse(peer.beacon) as {
            tools?: string[];
            capabilities?: string[];
          };
          const toolNames = beacon.tools ?? [];
          const capabilities = beacon.capabilities ?? [];

          for (const toolName of toolNames) {
            const capabilityId = capabilities[0] ?? toolName;
            tools.push({
              name: toolName,
              description: `Tool '${toolName}' vía satellite P2P`,
              inputSchema: undefined,
              providerId: peer.did,
              providerName: p.providerName || peer.did,
              capabilityId,
            });
          }
        } catch { /* beacon inválido */ }
      }
    }

    return tools;
  }

  /**
   * Ejecuta un tool call mediante el ciclo P2P completo.
   * A diferencia de McpHost WebSocket, cada callTool abre una nueva misión.
   */
  override async callTool(
    _providerId: string,
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
    _trace?: TraceContext
  ): Promise<DispatchResult> {
    const startedAt = Date.now();

    // Inferir capability del toolName (heurística simple: si es extract_text → document.ocr)
    const capability = guessCapability(toolName);

    // 1. Ciclo offer/bid/assign
    const result = await runMissionCycle({
      node: this.navNode,
      identity: this.navIdentity,
      collector: this.bidCollector,
      missionType: "tool_call",
      requiredCapabilities: [capability],
      bidDeadlineMs: BID_DEADLINE_MS,
    });

    if (!result) {
      throw new Error(`P2P: no hay Satellites con capability '${capability}'`);
    }

    const { missionId, bid } = result;

    // 2. Abrir stream directo al Satellite asignado
    const peerAddr = bid.providerMultiaddrs[0];
    if (!peerAddr) {
      throw new Error(`P2P: Satellite ${bid.providerDid} sin multiaddrs`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
    const conn = await this.navNode.dial(multiaddr(peerAddr) as any);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const stream = await conn.newStream(FHS_STREAM_PROTOCOL);

    const effectiveTimeout = timeoutMs ?? CALL_TIMEOUT_MS;
    let resultMessage: unknown = null;
    let dispatchMs: number | null = null;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`P2P: timeout esperando tool_result de ${bid.providerDid}`));
      }, effectiveTimeout);

      (async () => {
        try {
          const messages = decodeStream(stream);

          // 3. Handshake
          sendEnvelope(stream, "handshake", {
            fhsVersion: "0.1",
            listenAddrs: (this.navNode.getMultiaddrs() as Array<{ toString(): string }>).map((a) => a.toString()),
            beacon: JSON.stringify({ type: "navigator" }),
          });

          const ackFrame = await messages.next();
          if (ackFrame.done || ackFrame.value.type !== "handshake_ack") {
            throw new Error("P2P: respuesta inesperada al handshake del Satellite");
          }
          void (ackFrame.value.payload as HandshakeAckMessage);

          // 4. Tool call con un único tool call
          const toolCallId = randomUUID();
          sendEnvelope(stream, "tool_call", {
            missionId,
            toolCalls: [
              {
                id: toolCallId,
                type: "function",
                function: { name: toolName, arguments: JSON.stringify(args) },
              },
            ],
          });

          // 5. Esperar dispatch_ack + tool_result/tool_error
          while (true) {
            const frame = await messages.next();
            if (frame.done) break;

            const { type, payload } = frame.value;

            if (type === "dispatch_ack") {
              dispatchMs = Date.now() - startedAt;
              continue;
            }

            if (type === "tool_result") {
              const r = payload as ToolP2pCallResultMessage;
              resultMessage = { type: "tool.result", missionId: r.missionId, result: r.result };
              break;
            }

            if (type === "tool_error") {
              const e = payload as ToolP2pCallErrorMessage;
              throw new Error(`P2P tool error: ${e.error}`);
            }
          }

          clearTimeout(timeout);
          resolve();
        } catch (err) {
          clearTimeout(timeout);
          reject(err);
        }
      })();
    });

    return { message: resultMessage, dispatchMs };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function guessCapability(toolName: string): string {
  const mapping: Record<string, string> = {
    extract_text: "document.ocr",
    ocr_extract: "document.ocr",
    document_query: "document.retrieve",
    index_document: "document.index",
    search_kb: "knowledge.query",
  };
  return mapping[toolName] ?? toolName;
}
