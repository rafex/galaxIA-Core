import WebSocket from "ws";
import { randomUUID } from "node:crypto";
import type {
  GenerateRequest,
  GenerateResponse,
  ModelInfo,
  ToolDefinition,
  ToolParameterSchema,
  PublishedService,
  ChatRequestMessage,
  ChatDeltaMessage,
  ChatCompletedMessage,
  ChatErrorMessage,
} from "@rafex/galaxia-fhs-protocol";
import { signPayload, invokeSignaturePayload, type ChatCancelMessage } from "@rafex/galaxia-fhs-protocol";
import { getNavigatorIdentity } from "../identity.js";
import { acquireInFlight, releaseInFlight } from "./inflight.js";
import { wsOptions, clampTimeoutMs } from "./ws-security.js";
import { logTrace } from "../observability/trace.js";

// Invocación firmada (revisión del protocolo 2026-07-10): el Navigator prueba
// su identidad ante el provider en cada chat.request — el provider puede
// exigirla y responder UNAUTHORIZED a peers anónimos de la LAN.
function signedChatRequest(missionId: string, request: GenerateRequest): ChatRequestMessage {
  const identity = getNavigatorIdentity();
  const timestamp = Date.now();
  return {
    type: "chat.request",
    missionId,
    request,
    timestamp,
    callerId: identity.did,
    signature: signPayload(identity.privateKey, invokeSignaturePayload(identity.did, missionId, timestamp)),
  };
}

// Cancelación best-effort al abandonar por timeout: sin esto, el nodo sigue
// quemando CPU minutos después de que nadie espera la respuesta.
function sendCancel(ws: WebSocket, missionId: string) {
  if (ws.readyState === WebSocket.OPEN) {
    const msg: ChatCancelMessage = { type: "chat.cancel", missionId, timestamp: Date.now() };
    ws.send(JSON.stringify(msg));
  }
}

/** Envoltorio mínimo para narrowing de mensajes FHS crudos antes de castear al tipo específico. */
interface FhsMessageEnvelope {
  missionId?: string;
  type?: string;
}

/** Contexto de trazabilidad (DEC-0012). */
export interface TraceContext {
  conversationId: string;
  capability: string;
  /** DEC-0029: UUID de dispositivo del browser que inició la conversación. */
  deviceId?: string;
}

export interface LlmProviderSelection {
  nodeId: string;
  providerName: string;
  service: PublishedService;
  model: ModelInfo;
}

export interface GenerateDispatchResult {
  response: GenerateResponse;
  /** null si el nodo nunca envió dispatch.ack (SPEC-SATRATING-0001) */
  dispatchMs: number | null;
}

export class LlmGateway {
  /**
   * `timeoutMs` (opcional): "kill" configurable de la espera (DEC-0010) — el
   * usuario del Portal puede pedir esperar menos que el default. Es
   * responsabilidad del nodo (Star) resolver internamente si se atoró; esto
   * solo controla cuánto espera el Agent Server antes de abandonar.
   */
  async generate(
    selection: LlmProviderSelection,
    request: GenerateRequest,
    timeoutMs?: number,
    trace?: TraceContext
  ): Promise<GenerateDispatchResult> {
    return this.fhsGenerate(selection.nodeId, selection.service.endpoint.url, request, timeoutMs, trace);
  }

  async *stream(
    selection: LlmProviderSelection,
    request: GenerateRequest
  ): AsyncGenerator<string, GenerateResponse, unknown> {
    acquireInFlight(selection.nodeId);
    try {
      return yield* this.fhsStream(selection.service.endpoint.url, request);
    } finally {
      releaseInFlight(selection.nodeId);
    }
  }

  private fhsGenerate(
    nodeId: string,
    url: string,
    request: GenerateRequest,
    timeoutMs?: number,
    trace?: TraceContext
  ): Promise<GenerateDispatchResult> {
    // Backpressure (DEC-0072): contar la petición en vuelo mientras dura —
    // la resolución usa este contador para no mandar la N+1 a un nodo que
    // declaró capacidad N.
    acquireInFlight(nodeId);
    const settle = new Promise<GenerateDispatchResult>((resolve, reject) => {
      const ws = new WebSocket(url, wsOptions(url));
      const missionId = randomUUID();
      const startedAt = Date.now();
      // Mosquito: null hasta que llegue dispatch.ack (SPEC-SATRATING-0001).
      let ackAt: number | null = null;

      const emitTrace = (success: boolean, errorCode?: string) => {
        if (!trace) return;
        logTrace({
          conversationId: trace.conversationId,
          missionId,
          providerId: nodeId,
          capability: trace.capability,
          dispatchMs: ackAt ? ackAt - startedAt : null,
          totalMs: Date.now() - startedAt,
          success,
          errorCode,
          deviceId: trace.deviceId,
        });
      };

      const timeout = setTimeout(() => {
        sendCancel(ws, missionId);
        ws.close();
        emitTrace(false, "TIMEOUT");
        reject(new Error("Timeout esperando respuesta del LLM vía FHS"));
      }, clampTimeoutMs(timeoutMs, 310_000)); // lgtm[js/resource-exhaustion]: acotado a [1s, 10min] en ws-security.ts, CodeQL no sigue el clamp interprocedural

      ws.on("open", () => {
        ws.send(JSON.stringify(signedChatRequest(missionId, { ...request, stream: false })));
      });

      ws.on("message", (raw: Buffer) => {
        try {
          const msg = JSON.parse(String(raw)) as FhsMessageEnvelope;
          if (msg.missionId !== missionId) return;

          if (msg.type === "dispatch.ack") {
            ackAt = Date.now();
            return;
          }

          if (msg.type === "chat.completed") {
            clearTimeout(timeout);
            ws.close();
            const dispatchMs = ackAt ? ackAt - startedAt : null;
            emitTrace(true);
            // `toolCalls` es obligatorio en el tipo, pero nada lo garantiza
            // en el wire — un provider que lo omite crasheaba runtime.ts
            // (`response.toolCalls.length`) con una excepción no capturada:
            // la conversación quedaba colgada sin ningún error visible para
            // el usuario (encontrado con scripts/e2e-smoke.ts, DEC-0073).
            const response = (msg as ChatCompletedMessage).response;
            resolve({ response: { ...response, toolCalls: response.toolCalls ?? [] }, dispatchMs });
          } else if (msg.type === "chat.error") {
            clearTimeout(timeout);
            ws.close();
            emitTrace(false, (msg as ChatErrorMessage).code);
            reject(
              new Error(
                `FHS LLM error: ${(msg as ChatErrorMessage).message}`
              )
            );
          }
        } catch {
          // ignorar mensajes no JSON
        }
      });

      ws.on("error", (err) => {
        clearTimeout(timeout);
        emitTrace(false, "WEBSOCKET_ERROR");
        reject(new Error(`FHS WebSocket error: ${err.message}`));
      });

      ws.on("close", () => {
        clearTimeout(timeout);
      });
    });
    return settle.finally(() => releaseInFlight(nodeId));
  }

  private async *fhsStream(
    url: string,
    request: GenerateRequest
  ): AsyncGenerator<string, GenerateResponse, unknown> {
    const ws = new WebSocket(url, wsOptions(url));
    const missionId = randomUUID();

    type QueueItem =
      | { kind: "delta"; text: string }
      | { kind: "completed"; response: GenerateResponse }
      | { kind: "error"; message: string };

    const queue: QueueItem[] = [];
    let waiter: ((item: QueueItem) => void) | null = null;

    const enqueue = (item: QueueItem) => {
      if (waiter) {
        waiter(item);
        waiter = null;
      } else {
        queue.push(item);
      }
    };

    const wait = (): Promise<QueueItem> =>
      new Promise((resolve) => {
        waiter = resolve;
      });

    ws.on("open", () => {
      ws.send(JSON.stringify(signedChatRequest(missionId, { ...request, stream: true })));
    });

    ws.on("message", (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as FhsMessageEnvelope;
        if (msg.missionId !== missionId) return;

        if (msg.type === "chat.delta") {
          enqueue({ kind: "delta", text: (msg as ChatDeltaMessage).delta });
        } else if (msg.type === "chat.completed") {
          const response = (msg as ChatCompletedMessage).response;
          enqueue({
            kind: "completed",
            response: { ...response, toolCalls: response.toolCalls ?? [] },
          });
          ws.close();
        } else if (msg.type === "chat.error") {
          enqueue({
            kind: "error",
            message: (msg as ChatErrorMessage).message,
          });
          ws.close();
        }
      } catch {
        // ignorar
      }
    });

    ws.on("error", (err) => {
      enqueue({ kind: "error", message: err.message });
    });

    const timeout = setTimeout(() => {
      sendCancel(ws, missionId);
      enqueue({ kind: "error", message: "Timeout esperando stream FHS" });
      ws.close();
    }, clampTimeoutMs(undefined, 310_000));

    try {
      while (true) {
        const item = queue.length > 0 ? queue.shift()! : await wait();

        if (item.kind === "delta") {
          yield item.text;
          continue;
        }

        if (item.kind === "completed") {
          return item.response;
        }

        if (item.kind === "error") {
          throw new Error(`FHS LLM stream error: ${item.message}`);
        }
      }
    } finally {
      clearTimeout(timeout);
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }
  }

  // ── Utilidades ──────────────────────────────────────────────────────────

  supportsToolCalling(model: ModelInfo): boolean {
    return !!model.toolCalling?.supported;
  }

  toToolDefinitions(
    tools: Array<{
      name: string;
      description?: string;
      inputSchema?: ToolParameterSchema;
    }>
  ): ToolDefinition[] {
    return tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description || `Tool ${t.name}`,
        parameters: t.inputSchema || { type: "object", properties: {} },
      },
    }));
  }
}
