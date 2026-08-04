import type { AgentEvent, UserMessage } from "../types/fhs.js";
import { getOrCreateDeviceId } from "./device-id.js";

export interface ApiOptions {
  conversationId?: string;
  message: string;
  artifacts?: string[];
  attachmentName?: string;
  preferences?: {
    model?: string;
    scope?: "local" | "network" | "community" | "external";
    allowExternalProviders?: boolean;
    ocrMode?: "confirm" | "auto";
    kb?: string;
    kbMaxPerQuestion?: number;
    ipfs?: {
      enabled: boolean;
      network: "public" | "private";
      retention: "ephemeral" | "reuse";
    };
  };
}

export interface ChatConnection {
  send(options: ApiOptions): void;
  sendDecision(conversationId: string, use: boolean): void;
  sendKbDecision(conversationId: string, use: boolean): void;
  close(): void;
}

const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/chat/ws`;

/**
 * Si el socket muere por cualquier razón (el server se reinicia, la red
 * falla un instante, la laptop se durmió) hay que reconectar solo — sin
 * esto, `ready` se quedaba en `true` para siempre tras el primer `open`, y
 * cada envío siguiente llamaba `socket.send()` sobre un socket ya cerrado:
 * el mensaje se perdía en silencio, sin error visible para el usuario (bug
 * real encontrado en producción, 2026-08-01 — un mensaje enviado durante
 * un redeploy del Portal se quedó sin respuesta, sin ningún error en UI).
 */
export function connectToChat(
  onEvent: (event: AgentEvent) => void,
  onOpen?: () => void
): ChatConnection {
  let socket: WebSocket;
  let ready = false;
  let pending: ApiOptions | null = null;
  let closedByCaller = false;

  function openSocket() {
    socket = new WebSocket(WS_URL);

    socket.addEventListener("open", () => {
      ready = true;
      if (pending) {
        const toSend = pending;
        pending = null;
        send(toSend);
      }
      onOpen?.();
    });

    socket.addEventListener("message", (event: MessageEvent<string>) => {
      try {
        const payload = JSON.parse(event.data) as AgentEvent;
        onEvent(payload);
      } catch (err) {
        console.error("Failed to parse WebSocket event", err);
      }
    });

    socket.addEventListener("error", (err) => {
      console.error("WebSocket error", err);
      ready = false;
      onEvent({ type: "error", data: { code: "WS_ERROR", message: "Error de conexión" } });
    });

    socket.addEventListener("close", () => {
      ready = false;
      if (closedByCaller) return;
      onEvent({ type: "error", data: { code: "WS_CLOSED", message: "Conexión cerrada" } });
    });
  }

  openSocket();

  function send(options: ApiOptions) {
    const msg: {
      type: "start";
      conversationId?: string;
      deviceId: string;
      message: UserMessage;
      artifacts: string[];
      attachmentName?: string;
      preferences: NonNullable<ApiOptions["preferences"]>;
    } = {
      type: "start",
      conversationId: options.conversationId,
      deviceId: getOrCreateDeviceId(),
      message: { role: "user", content: options.message },
      artifacts: options.artifacts || [],
      attachmentName: options.attachmentName,
      preferences: options.preferences || {},
    };

    if (ready) {
      socket.send(JSON.stringify(msg));
      return;
    }

    // Socket no listo (nunca conectó, o se cayó) — reconecta y encola.
    pending = options;
    if (socket.readyState !== WebSocket.CONNECTING) {
      openSocket();
    }
  }

  function sendDecision(conversationId: string, use: boolean) {
    if (ready) {
      socket.send(JSON.stringify({ type: "attachment.decision", conversationId, use }));
    }
  }

  function sendKbDecision(conversationId: string, use: boolean) {
    if (ready) {
      socket.send(JSON.stringify({ type: "kb.decision", conversationId, use }));
    }
  }

  return {
    send,
    sendDecision,
    sendKbDecision,
    close: () => {
      closedByCaller = true;
      socket.close();
    },
  };
}
