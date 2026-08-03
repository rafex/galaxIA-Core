import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type { UserMessage } from "@rafex/galaxia-fhs-protocol";
import { AtlasClient } from "../atlas-client.js";
import { EventBus } from "../sse/event-bus.js";
import { AgentRuntime } from "../agent/runtime.js";
import type { LlmGateway } from "../providers/llm-gateway.js";
import type { McpHost } from "../providers/mcp-host.js";

export interface P2pProviders {
  atlasClient: AtlasClient;
  llmGateway: LlmGateway;
  mcpHost: McpHost;
}

export function setupChatApi(
  app: FastifyInstance,
  atlasClient: AtlasClient,
  eventBus: EventBus,
  p2p?: P2pProviders
) {
  const runtimes = new Map<string, AgentRuntime>();

  app.post("/api/chat", (req, reply) => {
    const body = req.body as {
      conversationId?: string;
      message: UserMessage;
      artifacts?: string[];
      preferences?: {
        model?: string;
        scope?: "local" | "network" | "community" | "external";
        allowExternalProviders?: boolean;
      };
    };

    const conversationId = body.conversationId || randomUUID();
    const effectiveAtlas = p2p?.atlasClient ?? atlasClient;
    const runtime = new AgentRuntime(
      effectiveAtlas,
      eventBus,
      conversationId,
      undefined,
      p2p?.llmGateway,
      p2p?.mcpHost
    );
    runtimes.set(conversationId, runtime);

    runtime
      .run(body.message, body.preferences || {})
      .catch((err: unknown) => {
        console.error("Agent runtime error:", err);
      })
      .finally(() => {
        runtimes.delete(conversationId);
      });

    reply.status(202);
    reply.header("Location", `/api/chat/${conversationId}/events`);
    return { conversationId };
  });
}
