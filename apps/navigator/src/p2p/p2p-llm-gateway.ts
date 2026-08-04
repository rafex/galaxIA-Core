/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-floating-promises, @typescript-eslint/prefer-promise-reject-errors */
/**
 * Gateway LLM P2P (DEC-0088).
 * Reemplaza LlmGateway (WebSocket) por el ciclo P2P:
 *   offer → bid → assign → stream directo → chat_request → deltas → chat_completed
 */

import { multiaddr } from "@multiformats/multiaddr";
import type {
  GenerateRequest,
  GenerateResponse,
  ModelInfo,
  PublishedService,
} from "@rafex/galaxia-fhs-protocol";
import { LlmGateway, type LlmProviderSelection, type GenerateDispatchResult } from "../providers/llm-gateway.js";
import type { TraceContext } from "../providers/llm-gateway.js";
import { runMissionCycle } from "./mission-cycle.js";
import { sendEnvelope, decodeStream } from "./stream-codec.js";
import type { FhsNode, FhsIdentity, BidCollector } from "./nav-node.js";
import { makeChatRequestEnvelope, makeHandshakeEnvelope, toolCallToLegacy } from "./p2p-wire.js";
import { FHS_STREAM_PROTOCOL } from "./fhs-p2p-types.js";

const BID_DEADLINE_MS = 2_000;
const STREAM_TIMEOUT_MS = 310_000;

export class P2pLlmGateway extends LlmGateway {
  constructor(
    private readonly navNode: FhsNode,
    private readonly navIdentity: FhsIdentity,
    private readonly bidCollector: BidCollector
  ) {
    super();
  }

  override async generate(
    _selection: LlmProviderSelection,
    request: GenerateRequest,
    timeoutMs?: number,
    _trace?: TraceContext
  ): Promise<GenerateDispatchResult> {
    const startedAt = Date.now();

    // 1. Ciclo offer/bid/assign
    const result = await runMissionCycle({
      node: this.navNode,
      identity: this.navIdentity,
      collector: this.bidCollector,
      missionType: "chat",
      requiredCapabilities: ["chat"],
      preferredModel: request.model,
      bidDeadlineMs: BID_DEADLINE_MS,
    });

    if (!result) {
      throw new Error("P2P: no hay Stars disponibles (sin bids para misión chat)");
    }

    const { missionId, bid } = result;

    // 2. Abrir stream directo al Star asignado
    const peerAddr = bid.providerMultiaddrs[0];
    if (!peerAddr) {
      throw new Error(`P2P: Star ${bid.providerDid} no tiene multiaddrs`);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
    const conn = await this.navNode.dial(multiaddr(peerAddr) as any);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const stream = await conn.newStream(FHS_STREAM_PROTOCOL);

    const effectiveTimeout = timeoutMs ?? STREAM_TIMEOUT_MS;
    let dispatchMs: number | null = null;
    let fullContent = "";
    let toolCalls: GenerateResponse["toolCalls"] = [];

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("P2P: timeout esperando respuesta del Star"));
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
            throw new Error("P2P: respuesta inesperada al handshake del Star");
          }

          // 4. Chat request
          sendEnvelope(stream, makeChatRequestEnvelope(this.navIdentity.did, missionId, request));

          // 5. Recolectar deltas y completed
          while (true) {
            const frame = await messages.next();
            if (frame.done) break;

            const payload = frame.value.payload;

            if (payload.case === "dispatchAck") {
              dispatchMs = Date.now() - startedAt;
              continue;
            }

            if (payload.case === "chatDelta") {
              fullContent += payload.value.delta;
              continue;
            }

            if (payload.case === "chatCompleted") {
              const completed = payload.value;
              if (!fullContent) fullContent = completed.content;
              toolCalls = completed.toolCalls.map(toolCallToLegacy);
              break;
            }

            if (payload.case === "chatError") {
              throw new Error(`P2P Star error: ${payload.value.error}`);
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

    const response: GenerateResponse = {
      message: { role: "assistant", content: fullContent },
      toolCalls: toolCalls ?? [],
      model: request.model ?? "auto",
      provider: "p2p",
    };

    return { response, dispatchMs };
  }
}

// ── Utilidades heredadas sin cambio ───────────────────────────────────────────
// supportsToolCalling() y toToolDefinitions() se heredan de LlmGateway

const P2P_MODEL: ModelInfo = {
  id: "auto",
  displayName: "Auto (P2P)",
  name: "Auto (P2P)",
  capabilities: ["tool.calling"],
  toolCalling: { supported: true },
} as unknown as ModelInfo;

/** Construye un PublishedService sintético para el selector interno P2P. */
export function p2pLlmService(): PublishedService {
  return {
    endpoint: { url: "p2p://navigator", protocol: "fhs" },
    capabilities: [{ id: "chat", type: "llm" }],
    models: [P2P_MODEL],
  } as unknown as PublishedService;
}

/** Construye un LlmProviderSelection sintético para P2P. */
export function p2pLlmSelection(did: string): LlmProviderSelection {
  return {
    nodeId: did,
    providerName: "P2P Star",
    service: p2pLlmService(),
    model: P2P_MODEL,
  };
}

// Re-export helper types para uso externo
export type { LlmProviderSelection, TraceContext, GenerateDispatchResult };
