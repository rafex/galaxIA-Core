/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-floating-promises, @typescript-eslint/prefer-promise-reject-errors, @typescript-eslint/require-await */
/**
 * McpHost P2P (DEC-0088).
 * Reemplaza McpHost (WebSocket) por el ciclo P2P:
 *   offer (tool_call) → bid → assign → stream directo → handshake → tool_call → tool_result
 *
 * loadToolsForCapabilities() lee del beacon en PeerCache (sin pre-flight WS).
 * callTool() hace el ciclo completo de misión.
 */

import type { PublishedService } from "@rafex/galaxia-fhs-protocol";
import { McpHost, type LoadedTool, type DispatchResult, type TraceContext } from "../providers/mcp-host.js";
import { runMissionCycle } from "./mission-cycle.js";
import { sendEnvelope, decodeStream } from "./stream-codec.js";
import type { FhsNode, FhsIdentity, BidCollector, PeerCache, ProviderDialer } from "./nav-node.js";
import { dialProvider } from "./nav-node.js";
import { dynamicValueToUnknown, makeHandshakeEnvelope, makeToolCallEnvelope } from "./p2p-wire.js";
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
        const capabilityIds = [
          ...peer.beacon.capabilities.map((capability) => capability.id),
          ...peer.beacon.agentCapabilities.map((capability) => capability.id),
        ];
        for (const advertised of advertisedTools(peer.beacon.provider?.tags ?? [], capabilityIds)) {
          tools.push({
            name: advertised.name,
            description: `Capability '${advertised.capabilityId}' vía satellite P2P`,
            inputSchema: undefined,
            providerId: peer.did,
            providerName: p.providerName || peer.did,
            capabilityId: advertised.capabilityId,
          });
        }
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
    trace?: TraceContext
  ): Promise<DispatchResult> {
    const startedAt = Date.now();

    // La capability real viene del beacon (LoadedTool.capabilityId → trace).
    // Deducirla del nombre fallaba con kb_query y document_index: la misión
    // pedía una capability que nadie anuncia y ningún provider pujaba.
    const capability = missionCapability(toolName, trace);

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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn = await dialProvider<any>(this.navNode as ProviderDialer, bid.providerDid, bid.providerMultiaddrs);
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
          sendEnvelope(stream, makeHandshakeEnvelope(
            this.navIdentity.did,
            (this.navNode.getMultiaddrs() as Array<{ toString(): string }>).map((a) => a.toString())
          ));

          const ackFrame = await messages.next();
          if (ackFrame.done || ackFrame.value.payload.case !== "handshakeAck") {
            throw new Error("P2P: respuesta inesperada al handshake del Satellite");
          }

          // 4. Tool call con un único tool call
          sendEnvelope(stream, makeToolCallEnvelope(this.navIdentity.did, missionId, toolName, args));

          // 5. Esperar dispatch_ack + tool_result/tool_error
          while (true) {
            const frame = await messages.next();
            if (frame.done) break;

            const payload = frame.value.payload;

            if (payload.case === "dispatchAck") {
              dispatchMs = Date.now() - startedAt;
              continue;
            }

            if (payload.case === "toolResult") {
              const r = payload.value;
              resultMessage = {
                type: "tool.result",
                missionId: r.missionId,
                toolCallId: r.toolCallId,
                result: dynamicValueToUnknown(r.result),
              };
              break;
            }

            if (payload.case === "toolError") {
              throw new Error(`P2P tool error: ${payload.value.error}`);
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
    document_query: "document.query",
    document_index: "document.index",
    index_document: "document.index",
    kb_query: "knowledge.query",
    search_kb: "knowledge.query",
  };
  return mapping[toolName] ?? toolName;
}

/** Capability que se pide en la misión: la del beacon si se conoce; si no, deducida del nombre. */
export function missionCapability(toolName: string, trace?: Pick<TraceContext, "capabilityId">): string {
  return trace?.capabilityId || guessCapability(toolName);
}

export function advertisedTools(
  tags: string[],
  capabilityIds: string[],
): Array<{ name: string; capabilityId: string }> {
  const names = tags
    .filter((tag) => tag.startsWith("tool:"))
    .map((tag) => tag.slice("tool:".length).trim())
    .filter(Boolean);
  const candidates = names.length > 0 ? names : capabilityIds;

  return candidates
    .map((name) => ({
      name,
      capabilityId: capabilityIds.length === 1 ? capabilityIds[0] : guessCapability(name),
    }))
    .filter((tool) => capabilityIds.includes(tool.capabilityId));
}
