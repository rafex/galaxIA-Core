import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import { randomUUID } from "node:crypto";
import type { AgentSSEEvent, UserMessage } from "@rafex/galaxia-fhs-protocol";
import { AtlasClient } from "../atlas-client.js";
import { EventBus } from "../sse/event-bus.js";
import { AgentRuntime, type ModelPreferences } from "../agent/runtime.js";

/** Envoltorio mínimo de mensajes entrantes del WS del Portal — cada rama de `handleMessage` los castea a su forma concreta. */
type IncomingMessage = { type?: string } & Record<string, unknown>;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface PendingAttachment {
  text: string;
  filename: string;
  question?: string;
  preferences: ModelPreferences;
  /** true una vez que el usuario confirmó "usar" sin haber escrito pregunta todavía */
  confirmed: boolean;
}

interface PendingKbRecommendation {
  message: UserMessage;
  preferences: ModelPreferences;
  candidates: Array<{ providerId: string; providerName: string; description: string }>;
}

export function setupChatWebSocket(
  app: FastifyInstance,
  atlasClient: AtlasClient,
  eventBus: EventBus
) {
  const runtimes = new Map<string, AgentRuntime>();
  // Estado del flujo de confirmación de OCR (SPEC-OCRCONFIRM-0001). Vive
  // mientras dure la conexión WebSocket — se limpia al confirmar, descartar
  // o cerrar la conexión. Mismo scope que `runtimes`.
  const pendingAttachments = new Map<string, PendingAttachment>();
  // SPEC-RAG-0001: conversaciones con un documento ya indexado — el runtime
  // consulta document_query en cada turno siguiente si el id está aquí.
  // Mismo scope y ciclo de vida que `pendingAttachments`/`runtimes`.
  const ragActiveConversations = new Set<string>();
  // SPEC-KB-0001: modo recomendado — una KB encontrada por matching
  // determinístico, esperando confirmación del usuario antes de consultarla.
  const pendingKbRecommendations = new Map<string, PendingKbRecommendation>();

  app.get("/api/chat/ws", { websocket: true }, (socket: WebSocket) => {
    let conversationId: string | null = null;
    // DEC-0029: ID de dispositivo del browser — persiste en localStorage del
    // cliente y se envía en cada mensaje "start". Se usa para deduplicar
    // futuros votos de community tags/rating subjetivo. No es una identidad
    // de persona. Undefined si el portal no lo envía (backward compat).
    let deviceId: string | undefined;

    const send = (event: AgentSSEEvent) => {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify(event));
      }
    };

    const unsubscribe = eventBus.subscribe({
      id: `ws-chat-${Date.now()}`,
      send: (event: AgentSSEEvent) => {
        // Eventos con conversationId solo se reenvían al socket dueño de esa
        // conversación — ver DEC-0018. (node.online/node.lost viven en el
        // EventBus interno de Atlas, un proceso aparte desde DEC-0035 — no
        // llegan a este EventBus de Navigator.)
        const eventConversationId = "conversationId" in event.data ? event.data.conversationId : undefined;
        if (eventConversationId && eventConversationId !== conversationId) return;
        send(event);
      },
    });

    socket.on("message", (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString()) as IncomingMessage;
        handleMessage(msg);
      } catch {
        send({ type: "error", data: { code: "PARSE_ERROR", message: "Invalid JSON" } });
      }
    });

    socket.on("close", () => {
      unsubscribe();
      if (conversationId) {
        runtimes.delete(conversationId);
        pendingAttachments.delete(conversationId);
        ragActiveConversations.delete(conversationId);
        pendingKbRecommendations.delete(conversationId);
      }
    });

    function runChat(
      id: string,
      message: UserMessage,
      preferences: ModelPreferences,
      preExtractedText?: string,
      artifacts?: string[],
      kbProviderIds?: string[]
    ) {
      const runtime = new AgentRuntime(atlasClient, eventBus, id, deviceId);
      runtimes.set(id, runtime);

      runtime
        .run(message, preferences, artifacts, preExtractedText, ragActiveConversations.has(id), kbProviderIds)
        .catch((err: unknown) => {
          console.error("Agent runtime error:", err);
          send({ type: "error", data: { conversationId: id, code: "RUNTIME_ERROR", message: errorMessage(err) } });
        })
        .finally(() => {
          runtimes.delete(id);
        });
    }

    // SPEC-KB-0001/SPEC-KB-0002: modo recomendado — matching determinístico
    // contra capability.description/tags top-N sobre un umbral; si nada
    // califica, el LLM elige una sola vez entre las KBs disponibles (caso
    // límite, con parser tolerante determinístico, nunca sin validar). Se
    // pide confirmación antes de consultar en ambos casos — el requisito no
    // negociable de SPEC-KB-0002 es que las KBs consultadas siempre se
    // muestren, nunca una elección oculta. Modo manual (preferences.kb) se
    // resuelve sin pasar por aquí — se aplica directo, sin confirmación
    // (SPEC-KB-0001: "esa elección se usa... hasta que el usuario la cambie").
    function resolveKbAndChat(id: string, message: UserMessage, preferences: ModelPreferences) {
      if (preferences.kb) {
        runChat(id, message, preferences, undefined, undefined, [preferences.kb]);
        return;
      }

      const runtime = new AgentRuntime(atlasClient, eventBus, id, deviceId);
      runtime
        .resolveKbCandidates(message.content, preferences)
        .then(({ candidates, chosenByLlm }) => {
          if (candidates.length === 0) {
            runChat(id, message, preferences);
            return;
          }
          pendingKbRecommendations.set(id, { message, preferences, candidates });
          send({
            type: "kb.recommended",
            data: { conversationId: id, candidates, chosenByLlm },
          });
        })
        .catch((err: unknown) => {
          console.error("KB recommendation error:", err);
          runChat(id, message, preferences);
        });
    }

    // SPEC-RAG-0001: se llama en el mismo instante en que se confirma
    // "usar" el adjunto — nunca antes, nunca de forma especulativa. Si no
    // hay ningún rag-provider disponible, simplemente no se marca la
    // conversación como "RAG activa" (degradación graceful, sin error
    // visible: el usuario ya obtiene su respuesta vía el texto OCR completo).
    function indexForRag(id: string, text: string, preferences: ModelPreferences) {
      const runtime = new AgentRuntime(atlasClient, eventBus, id, deviceId);
      runtime
        .indexDocumentForRag(text, preferences)
        .then((indexed) => {
          if (indexed) ragActiveConversations.add(id);
        })
        .catch((err: unknown) => {
          console.error("RAG indexing error:", err);
        });
    }

    function handleMessage(msg: IncomingMessage) {
      if (msg.type === "start") {
        conversationId = (msg.conversationId as string | undefined) || randomUUID();
        deviceId = (msg.deviceId as string | undefined) || undefined;
        const body = msg as {
          conversationId?: string;
          message: UserMessage;
          artifacts?: string[];
          attachmentName?: string;
          preferences?: ModelPreferences;
        };

        const id = conversationId;
        send({ type: "session", data: { conversationId: id } });
        const preferences = body.preferences || {};

        if (body.artifacts && body.artifacts.length > 0) {
          if (preferences.ocrMode === "auto") {
            // Modo "automático": OCR determinístico + respuesta del LLM en una
            // sola llamada, sin pedir confirmación (comportamiento original
            // de DEC-0020). El usuario eligió priorizar velocidad sobre control.
            runChat(id, body.message, preferences, undefined, body.artifacts);
            return;
          }

          // Modo "confirmar" (default, SPEC-OCRCONFIRM-0001): se extrae el
          // texto y se muestra al usuario, pero NO se llama al LLM todavía.
          const runtime = new AgentRuntime(atlasClient, eventBus, id, deviceId);
          runtime
            .extractOcrText(body.artifacts, body.attachmentName || "archivo adjunto", preferences)
            .then((text) => {
              if (text) {
                pendingAttachments.set(id, {
                  text,
                  filename: body.attachmentName || "archivo adjunto",
                  question: body.message?.content || undefined,
                  preferences,
                  confirmed: false,
                });
              } else {
                send({
                  type: "error",
                  data: { conversationId: id, code: "OCR_FAILED", message: "No se pudo procesar el archivo adjunto." },
                });
              }
            })
            .catch((err: unknown) => {
              console.error("OCR extraction error:", err);
              send({ type: "error", data: { conversationId: id, code: "RUNTIME_ERROR", message: errorMessage(err) } });
            });
          return;
        }

        // Sin adjunto en este turno: ¿había un documento ya confirmado
        // esperando la próxima pregunta del usuario?
        const pending = pendingAttachments.get(id);
        if (pending?.confirmed) {
          pendingAttachments.delete(id); // uso único (ver alcance del SPEC)
          runChat(id, body.message, preferences, pending.text);
          return;
        }

        resolveKbAndChat(id, body.message, preferences);
        return;
      }

      if (msg.type === "kb.decision") {
        const body = msg as { conversationId: string; use: boolean };
        const pending = pendingKbRecommendations.get(body.conversationId);
        if (!pending) return;
        pendingKbRecommendations.delete(body.conversationId);

        runChat(
          body.conversationId,
          pending.message,
          pending.preferences,
          undefined,
          undefined,
          body.use ? pending.candidates.map((c) => c.providerId) : undefined
        );
        return;
      }

      if (msg.type === "attachment.decision") {
        const body = msg as { conversationId: string; use: boolean };
        const pending = pendingAttachments.get(body.conversationId);
        if (!pending) return;

        if (!body.use) {
          pendingAttachments.delete(body.conversationId);
          return;
        }

        indexForRag(body.conversationId, pending.text, pending.preferences);

        if (pending.question) {
          // El usuario ya había escrito su pregunta junto con el archivo —
          // no hace falta que la reescriba.
          pendingAttachments.delete(body.conversationId);
          runChat(body.conversationId, { role: "user", content: pending.question }, pending.preferences, pending.text);
        } else {
          // Confirmó "usar", pero aún no hay pregunta — esperar el próximo
          // mensaje del usuario y anteponer el texto entonces.
          pending.confirmed = true;
        }
        return;
      }
    }
  });
}
