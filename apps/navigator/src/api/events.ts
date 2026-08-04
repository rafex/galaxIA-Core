import type { FastifyInstance } from "fastify";
import { EventBus } from "../sse/event-bus.js";
import type { AgentEvent } from "../agent/events.js";

export function setupEventsApi(app: FastifyInstance, eventBus: EventBus) {
  app.get("/api/chat/:id/events", async (req, reply) => {
    const { id } = req.params as { id: string };

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const clientId = `sse-${id}-${Date.now()}`;

    const unsubscribe = eventBus.subscribe({
      id: clientId,
      send: (event: AgentEvent) => {
        try {
          reply.raw.write(`event: ${event.type}\n`);
          reply.raw.write(`data: ${JSON.stringify(event.data)}\n\n`);
        } catch {
          // Client disconnected
          unsubscribe();
        }
      },
    });

    req.raw.on("close", unsubscribe);
  });
}
